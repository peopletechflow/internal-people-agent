import { z } from "zod";
import { AccessDenied, type Caller } from "./core/identity.js";
import { permissionsFor, type RoleTable } from "./core/policy.js";
import { digest } from "./core/preview.js";
import type { Store } from "./core/store.js";
import type { Backend } from "./core/backend.js";
import { CapabilityGated, UpstreamToolError } from "./core/upstream.js";
import { defineTool, type ToolDef } from "./core/tool.js";
import { untrusted, UNTRUSTED_NOTE } from "./core/untrusted.js";
import { IntentEnum, type Classification, type Intent, type IntentClassifier } from "./jev.js";

export const ROLES: RoleTable = {
  employee: ["pc.self.read", "pc.policy.read", "pc.adapters.read", "pc.transfer.propose", "pc.transfer.commit", "pc.pbp.propose", "pc.pbp.commit"],
  readonly: ["pc.self.read", "pc.policy.read", "pc.adapters.read"],
  transfer_freeze: ["!pc.transfer.commit"],
};
const CAP_PERMISSION: Record<string, string> = { benefits_read: "pc.self.read", equity_read: "pc.self.read", policy_search: "pc.policy.read" };
const INTENT_SOURCES: Record<Intent, string[]> = { benefits_question: ["benefits_read", "policy_search"], equity_question: ["equity_read", "policy_search"], policy_question: ["policy_search"], team_transfer: ["policy_search"], pbp_help: [], out_of_scope: [] };
const NEXT: Record<Intent, string[]> = { benefits_question: [], equity_question: [], policy_question: [], team_transfer: ["check_my_transfer_eligibility", "preview_team_transfer_request"], pbp_help: ["preview_pbp_handoff"], out_of_scope: [] };

const DISCLAIMER = "Information from your records and published policy, not financial, tax, or legal advice. Check the cited source for the final word.";
const SENSITIVE = new Set(["benefit_elections", "equity_grants"]);
const HANDOFF_FIELDS = ["benefit_elections", "equity_grants", "transfer_proposal"] as const;

export type SourceRef = { sourceId: string; system: string; recordId: string; asOf: string; example: boolean };
export type Step = { step: "identity_scope" | "intent" | "permitted_retrieval" | "grounding" | "answer_or_preview" | "confirmation_or_escalation"; status: "done" | "blocked" | "needs_user" | "pending" | "skipped"; reason: string; evidence?: string[]; at: string };
type Chain = { question: string; intent: Intent | null; classification: Classification | null; steps: Step[] };
type Transfer = { positionId: string; fromTeam: string; toTeam: string; effectiveDate: string; reason: string };
type Handoff = { topic: string; message: string; fields: Record<string, unknown>; consentedSensitiveFields: string[] };

export type Deps = { backend: Backend; store: Store; classifier?: IntentClassifier; jevMinConfidence?: number; now?: () => Date };

export function createPeopleAgent(deps: Deps) {
  const { backend, store } = deps;
  const now = deps.now ?? (() => new Date());
  const example = backend.mode === "fixture";
  const minConf = deps.jevMinConfidence ?? 0.6;
  const step = (s: Omit<Step, "at">): Step => ({ ...s, at: now().toISOString() });

  const appendSteps = async (c: Caller, chainId: string | undefined, steps: Omit<Step, "at">[]) => {
    if (!chainId) return;
    const ch = await store.getResource<Chain>(c, chainId, "decision_chain");
    await store.updateResource<Chain>(c, chainId, "decision_chain", ch.version, [ch.state], { content: { ...ch.content, steps: [...ch.content.steps, ...steps.map(step)] }, state: ch.state });
  };

  async function answerPack(c: Caller, question: string, caps: string[]) {
    const perms = permissionsFor(c, ROLES);
    const facts: { topic: string; fact: unknown; citation: SourceRef }[] = [];
    const passages: { title: string; passage: ReturnType<typeof untrusted>; citation: SourceRef }[] = [];
    const retrieval: { capability: string; status: "done" | "blocked"; reason: string }[] = [];
    for (const cap of caps) {
      if (!perms.has(CAP_PERMISSION[cap])) { retrieval.push({ capability: cap, status: "blocked", reason: "no permission" }); continue; }
      if (!backend.isAvailable(cap)) { retrieval.push({ capability: cap, status: "blocked", reason: backend.capabilities().find((x) => x.capability === cap)?.reason ?? "gated" }); continue; }
      const sys = backend.sourceSystem(cap);
      if (cap === "benefits_read") {
        const b = await backend.invoke<any>(cap, {}, c);
        for (const e of b.elections) facts.push({ topic: "benefits", fact: { plan: e.plan, coverage: e.coverage, tier: e.tier, costPerPayPeriod: e.costPerPayPeriod }, citation: { sourceId: `benefits:${e.recordId}`, system: sys, recordId: e.recordId, asOf: e.asOf, example } });
        if (b.nextEnrollmentWindow) facts.push({ topic: "benefits", fact: { nextEnrollmentWindow: { opens: b.nextEnrollmentWindow.opens, closes: b.nextEnrollmentWindow.closes } }, citation: { sourceId: `benefits:${b.nextEnrollmentWindow.recordId}`, system: sys, recordId: b.nextEnrollmentWindow.recordId, asOf: b.nextEnrollmentWindow.asOf, example } });
      } else if (cap === "equity_read") {
        const q = await backend.invoke<any>(cap, {}, c);
        for (const g of q.grants) facts.push({ topic: "equity", fact: { grantId: g.grantId, type: g.type, unitsGranted: g.unitsGranted, unitsVested: g.unitsVested, schedule: g.schedule }, citation: { sourceId: `equity:${g.grantId}`, system: sys, recordId: g.grantId, asOf: g.asOf, example } });
      } else if (cap === "policy_search") {
        const p = await backend.invoke<any>(cap, { query: question }, c);
        for (const r of p.results.slice(0, 4)) passages.push({ title: r.title, passage: untrusted(r.text), citation: { sourceId: `${r.policyId}#${r.anchor}`, system: sys, recordId: `${r.policyId} v${r.version}`, asOf: r.effective, example } });
      }
      retrieval.push({ capability: cap, status: "done", reason: `read via ${sys}` });
    }
    const citations = [...facts.map((f) => f.citation), ...passages.map((p) => p.citation)];
    return { question: untrusted(question), facts, passages, citations, retrieval, gaps: citations.length === 0 ? ["No matching records or policy passages. Offer a PBP handoff."] : [], instructions: "Answer only from facts and passages. Cite sourceId and asOf for each claim. " + UNTRUSTED_NOTE, retrievedAt: now().toISOString(), disclaimer: DISCLAIMER, exampleData: example };
  }

  async function classify(question: string, clientIntent?: Intent): Promise<{ intent: Intent | null; classification: Classification | null; s: Omit<Step, "at"> }> {
    if (!deps.classifier) {
      if (!clientIntent) return { intent: null, classification: null, s: { step: "intent", status: "needs_user", reason: "No intent given and no server classifier configured. The client should pass intent." } };
      return { intent: clientIntent, classification: { provider: "client", intent: clientIntent, confidence: null, anyFit: null, sensitive: null }, s: { step: "intent", status: "done", reason: `Intent '${clientIntent}' chosen by the client (default runtime).` } };
    }
    let r: Classification;
    try { r = await deps.classifier.classify(question); }
    catch (e) { return { intent: null, classification: null, s: { step: "intent", status: "needs_user", reason: `Jev classifier unavailable (${(e as Error).name}). Ask the user what they need; nothing is assumed.` } }; }
    const pct = (n: number | null) => (n === null ? "n/a" : n.toFixed(2));
    const base = `Jev ${r.model ?? ""} chose '${r.intent ?? "unknown"}' (confidence ${pct(r.confidence)}, fits-scope ${pct(r.anyFit)}, sensitive ${pct(r.sensitive)})`;
    if (!r.intent || (r.confidence ?? 0) < minConf || (r.anyFit ?? 0) < 0.5 && r.intent !== "out_of_scope") return { intent: null, classification: r, s: { step: "intent", status: "needs_user", reason: `${base}. Below threshold ${minConf}; ask the user to clarify.` } };
    if (clientIntent && clientIntent !== r.intent) return { intent: null, classification: r, s: { step: "intent", status: "needs_user", reason: `${base}, but the client proposed '${clientIntent}'. Ask the user which one.` } };
    return { intent: r.intent, classification: r, s: { step: "intent", status: "done", reason: base } };
  }

  async function transferEligibility(c: Caller, positionId: string) {
    const e = await backend.invoke<any>("transfer_eligibility", { positionId }, c);
    return { ...e, positionId, note: "Eligibility is a pre-check. Managers and HR decide through the business process.", exampleData: example };
  }

  /** Shared commit path: preview consume (single use) -> durable claim -> upstream write -> explicit outcome. */
  async function commitWrite<T extends object>(c: Caller, o: { tool: string; kind: string; resourceId: string; previewToken: string; key: string; cap: string; input: Record<string, unknown> }) {
    const res = await store.getResource<T>(c, o.resourceId, o.kind);
    const prior = await store.getCommit(c, o.tool, o.key);
    const replay = () => { if (!prior || prior.digest !== digest(res.content) || prior.resource_id !== res.id) throw new AccessDenied("idempotencyKey was already used for different content."); return { status: prior.status, result: prior.result, replayed: true }; };
    if (prior) return replay();
    if (!backend.isAvailable(o.cap)) throw new CapabilityGated(o.cap, backend.capabilities().find((x) => x.capability === o.cap)?.reason ?? "gated");
    if (res.state !== "previewed") throw new AccessDenied("Preview the current version first.");
    let d: string;
    try { d = await store.consumePreview(c, o.previewToken, o.kind, res.id, res.version, res.content); }
    catch (e) { const again = await store.getCommit(c, o.tool, o.key); if (again && again.digest === digest(res.content)) return { status: again.status, result: again.result, replayed: true }; throw e; }
    const out = await store.commitOnce(c, o.tool, o.key, res.id, d, async () => { const r = await backend.invoke<Record<string, unknown>>(o.cap, { ...o.input, idempotencyKey: o.key }, c); return { result: r, upstreamRef: String(r.requestRef ?? r.caseRef ?? "") }; }, (e) => (e instanceof UpstreamToolError ? "failed" : "unknown"));
    const state = out.status === "succeeded" ? "submitted" : out.status === "failed" ? "draft" : "unknown";
    await store.updateResource(c, res.id, o.kind, res.version, ["previewed"], { state });
    return out;
  }

  async function reconcile(c: Caller, o: { tool: string; kind: string; resourceId: string; key: string; statusCap: string }) {
    const row = await store.getCommit(c, o.tool, o.key);
    if (!row || row.resource_id !== o.resourceId) throw new AccessDenied("No commit with that key for this item.");
    if (row.status !== "unknown") return { status: row.status, result: row.result, reconciled: false };
    if (!backend.isAvailable(o.statusCap)) return { status: "unknown", reconciled: false, note: `Cannot check automatically (${o.statusCap} not available). Check Workday before trying again; do not resubmit with a new key until you know.` };
    const s = await backend.invoke<{ found: boolean; requestRef?: string; caseRef?: string; status?: string }>(o.statusCap, { idempotencyKey: o.key }, c);
    const res = await store.getResource(c, o.resourceId, o.kind);
    if (s.found) { await store.resolveUnknown(c, o.tool, o.key, "succeeded", s, s.requestRef ?? s.caseRef); await store.updateResource(c, res.id, o.kind, res.version, ["unknown"], { state: "submitted" }); return { status: "succeeded", result: s, reconciled: true }; }
    await store.resolveUnknown(c, o.tool, o.key, "failed", { error: "not found upstream after unknown outcome" });
    await store.updateResource(c, res.id, o.kind, res.version, ["unknown"], { state: "draft" });
    return { status: "failed", reconciled: true, note: "Upstream has no record. You can preview and submit again with a new key." };
  }

  const key = z.string().max(128);
  const chainId = z.string().max(64).optional();
  const tools: ToolDef[] = [
    defineTool({ name: "list_hr_adapters", kind: "read", permission: "pc.adapters.read", description: "Which Workday MCP capabilities are available or gated for this tenant, and why.", input: {},
      run: () => ({ mode: backend.mode, capabilities: backend.capabilities(), intentClassifier: deps.classifier ? "jev (optional, server-side)" : "client (Claude, default)", otherSystems: [{ system: "equity administration platform", status: "only via an upstream Workday MCP tool mapped to equity_read" }] }) }),
    defineTool({ name: "start_decision_chain", kind: "read", permission: "pc.self.read", description: "Start an auditable decision chain for an employee request: identity and scope, intent, permitted retrieval, grounding, then the answer pack or the next action. Pass intent (the client's classification) unless the server uses Jev.",
      input: { question: z.string().min(3).max(1000), intent: IntentEnum.optional() },
      run: async (a, c) => {
        const perms = [...permissionsFor(c, ROLES)].sort();
        const steps: Omit<Step, "at">[] = [{ step: "identity_scope", status: "done", reason: `Caller from session (${backend.mode}); roles ${c.roles.join(",")}; ${perms.length} permissions.`, evidence: perms }];
        const cl = await classify(a.question, a.intent);
        steps.push(cl.s);
        let pack: Awaited<ReturnType<typeof answerPack>> | undefined;
        if (cl.intent && cl.intent !== "out_of_scope") {
          pack = await answerPack(c, a.question, INTENT_SOURCES[cl.intent]);
          steps.push({ step: "permitted_retrieval", status: pack.retrieval.some((r) => r.status === "done") || INTENT_SOURCES[cl.intent].length === 0 ? "done" : "blocked", reason: pack.retrieval.map((r) => `${r.capability}: ${r.status} (${r.reason})`).join("; ") || "No sources needed for this intent." });
          steps.push({ step: "grounding", status: pack.citations.length ? "done" : "blocked", reason: pack.citations.length ? `${pack.citations.length} citations` : "Nothing to ground an answer on.", evidence: pack.citations.map((x) => x.sourceId) });
          const next = NEXT[cl.intent];
          steps.push({ step: "answer_or_preview", status: next.length ? "pending" : pack.citations.length ? "done" : "blocked", reason: next.length ? `Next: ${next.join(" then ")}` : pack.citations.length ? "Answer pack ready for the client to write a cited answer." : "No grounded answer; offer a PBP handoff." });
          steps.push({ step: "confirmation_or_escalation", status: next.length ? "pending" : pack.citations.length ? "skipped" : "pending", reason: next.length ? "Needs a preview and the user's explicit confirmation." : pack.citations.length ? "Read-only answer, nothing to confirm." : "Offer preview_pbp_handoff with consent." });
        } else if (cl.intent === "out_of_scope") steps.push({ step: "permitted_retrieval", status: "skipped", reason: "Out of scope; nothing retrieved." });
        if ((cl.classification?.sensitive ?? 0) >= 0.5) steps.push({ step: "confirmation_or_escalation", status: "needs_user", reason: "Message may contain sensitive details. They are never shared without explicit consent." });
        const ch = await store.createResource<Chain>(c, "decision_chain", { question: a.question, intent: cl.intent, classification: cl.classification, steps: steps.map(step) }, {}, "open");
        return { decisionChainId: ch.id, intent: cl.intent, steps: ch.content.steps, answerPack: pack, nextTools: cl.intent ? NEXT[cl.intent] : [] };
      } }),
    defineTool({ name: "get_decision_chain", kind: "read", permission: "pc.self.read", description: "Read one of your decision chains (steps, statuses, reasons, evidence refs).", input: { decisionChainId: z.string().max(64) },
      run: async (a, c) => { const ch = await store.getResource<Chain>(c, a.decisionChainId, "decision_chain"); return { decisionChainId: ch.id, intent: ch.content.intent, classification: ch.content.classification, steps: ch.content.steps }; } }),
    defineTool({ name: "get_my_benefits", kind: "read", permission: "pc.self.read", description: "Your own benefit elections and enrollment window, with sources.", input: {},
      run: async (_a, c) => ({ ...(await backend.invoke<object>("benefits_read", {}, c)), source: backend.sourceSystem("benefits_read"), exampleData: example, retrievedAt: now().toISOString(), disclaimer: DISCLAIMER }) }),
    defineTool({ name: "get_my_equity", kind: "read", permission: "pc.self.read", description: "Your own equity grants and vesting, with sources. Not tax or financial advice.", input: {},
      run: async (_a, c) => ({ ...(await backend.invoke<object>("equity_read", {}, c)), source: backend.sourceSystem("equity_read"), exampleData: example, retrievedAt: now().toISOString(), disclaimer: DISCLAIMER }) }),
    defineTool({ name: "search_hr_policy", kind: "read", permission: "pc.policy.read", description: "Search your organization's HR policies. Quoted passages with citations.", input: { query: z.string().min(2).max(200) },
      run: async (a, c) => { const p = await answerPack(c, a.query, ["policy_search"]); return { note: UNTRUSTED_NOTE, results: p.passages, retrieval: p.retrieval }; } }),
    defineTool({ name: "build_answer_pack", kind: "read", permission: "pc.self.read", description: "Collect your own facts and matching policy passages for a question, each with source and date. Says what is missing instead of guessing.",
      input: { question: z.string().min(3).max(500), topics: z.array(z.enum(["benefits", "equity", "policy"])).min(1).max(3) },
      run: (a, c) => answerPack(c, a.question, [...(a.topics.includes("benefits") ? ["benefits_read"] : []), ...(a.topics.includes("equity") ? ["equity_read"] : []), "policy_search"]) }),
    defineTool({ name: "check_my_transfer_eligibility", kind: "read", permission: "pc.self.read", description: "Pre-check your eligibility for an open position.", input: { positionId: z.string().max(64), decisionChainId: chainId },
      run: async (a, c) => { const e = await transferEligibility(c, a.positionId); await appendSteps(c, a.decisionChainId, [{ step: "grounding", status: e.eligible ? "done" : "blocked", reason: `Eligibility for ${a.positionId}: ${e.eligible ? "eligible" : "not eligible"}`, evidence: e.checks.map((x: any) => `${x.rule}=${x.pass}`) }]); return e; } }),
    defineTool({ name: "preview_team_transfer_request", kind: "propose", permission: "pc.transfer.propose", description: "Draft a transfer request and show the exact request that would start the approval process. Pass proposalId to revise; revising invalidates the old preview.",
      input: { positionId: z.string().max(64), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().min(5).max(1000), proposalId: z.string().max(64).optional(), decisionChainId: chainId },
      run: async (a, c) => {
        const el = await transferEligibility(c, a.positionId);
        if (!el.eligible) throw new AccessDenied(`Not eligible: ${el.checks.filter((x: any) => !x.pass).map((x: any) => x.rule).join("; ")}`);
        const content: Transfer = { positionId: a.positionId, fromTeam: el.fromTeam, toTeam: el.toTeam, effectiveDate: a.effectiveDate, reason: a.reason };
        const r = a.proposalId
          ? await (async () => { const ex = await store.getResource<Transfer>(c, a.proposalId!, "transfer"); return store.updateResource<Transfer>(c, ex.id, "transfer", ex.version, ["draft", "previewed"], { content, state: "previewed" }); })()
          : await store.createResource<Transfer>(c, "transfer", content, {}, "previewed");
        const p = await store.issuePreview(c, "transfer", r.id, r.version, content);
        await appendSteps(c, a.decisionChainId, [{ step: "answer_or_preview", status: "done", reason: `Preview v${r.version} issued`, evidence: [r.id, p.contentDigest] }, { step: "confirmation_or_escalation", status: "pending", reason: "Waiting for the user's explicit confirmation." }]);
        return { proposalId: r.id, version: r.version, exactRequest: content, ...p, submitAvailable: backend.isAvailable("transfer_submit"), whatHappensNext: "Confirming starts the transfer business process. Your manager, the receiving manager, and HR still approve it. It is not a completed transfer.", exampleData: example };
      } }),
    defineTool({ name: "commit_team_transfer_request", kind: "commit", permission: "pc.transfer.commit", description: "Submit a previewed transfer request for approval. Needs previewToken, confirm=true and an idempotencyKey.",
      input: { proposalId: z.string().max(64), previewToken: z.string().max(128), idempotencyKey: key, confirm: z.literal(true), decisionChainId: chainId },
      run: async (a, c) => {
        const res = await store.getResource<Transfer>(c, a.proposalId, "transfer");
        const out = await commitWrite<Transfer>(c, { tool: "commit_team_transfer_request", kind: "transfer", resourceId: a.proposalId, previewToken: a.previewToken, key: a.idempotencyKey, cap: "transfer_submit", input: { positionId: res.content.positionId, effectiveDate: res.content.effectiveDate, reason: res.content.reason } });
        if (!out.replayed) await appendSteps(c, a.decisionChainId, [{ step: "confirmation_or_escalation", status: out.status === "succeeded" ? "done" : "blocked", reason: `User confirmed; submit outcome ${out.status}`, evidence: [a.proposalId] }]);
        return { proposalId: a.proposalId, ...out, note: out.status === "unknown" ? "Outcome unknown. Run reconcile_my_transfer_request before doing anything else." : out.status === "succeeded" ? "Pending manager and HR approval." : undefined, exampleData: example };
      } }),
    defineTool({ name: "reconcile_my_transfer_request", kind: "commit", permission: "pc.transfer.commit", description: "Resolve a transfer submit whose outcome is unknown by checking the upstream record.", input: { proposalId: z.string().max(64), idempotencyKey: key },
      run: (a, c) => reconcile(c, { tool: "commit_team_transfer_request", kind: "transfer", resourceId: a.proposalId, key: a.idempotencyKey, statusCap: "transfer_status" }) }),
    defineTool({ name: "get_my_requests", kind: "read", permission: "pc.self.read", description: "Status of your own transfer requests and PBP handoffs.", input: {},
      run: async (_a, c) => ({ transfers: (await store.listResources<Transfer>(c, "transfer")).map((r) => ({ proposalId: r.id, version: r.version, state: r.state, toTeam: r.content.toTeam })), handoffs: (await store.listResources<Handoff>(c, "handoff")).map((h) => ({ handoffId: h.id, state: h.state, topic: h.content.topic })) }) }),
    defineTool({ name: "preview_pbp_handoff", kind: "propose", permission: "pc.pbp.propose", description: "Prepare a minimal summary for your People Business Partner. Only fields you list are included; benefit_elections and equity_grants also need explicit consent. Contact details are removed.",
      input: { topic: z.string().min(3).max(120), message: z.string().max(2000), include: z.array(z.enum(HANDOFF_FIELDS)).max(3), consentSensitive: z.array(z.enum(["benefit_elections", "equity_grants"])).max(2).default([]), transferProposalId: z.string().max(64).optional(), decisionChainId: chainId },
      run: async (a, c) => {
        const missing = a.include.filter((f) => SENSITIVE.has(f) && !a.consentSensitive.includes(f as never));
        if (missing.length) throw new AccessDenied(`Sensitive fields need explicit consent: ${missing.join(", ")}`);
        const fields: Record<string, unknown> = {};
        for (const f of a.include) {
          if (f === "benefit_elections") fields[f] = (await backend.invoke<any>("benefits_read", {}, c)).elections.map((e: any) => ({ plan: e.plan, coverage: e.coverage }));
          if (f === "equity_grants") fields[f] = (await backend.invoke<any>("equity_read", {}, c)).grants.map((g: any) => ({ grantId: g.grantId, type: g.type }));
          if (f === "transfer_proposal") { if (!a.transferProposalId) throw new AccessDenied("transfer_proposal needs your transferProposalId."); const p = await store.getResource<Transfer>(c, a.transferProposalId, "transfer"); fields[f] = { proposalId: p.id, toTeam: p.content.toTeam, state: p.state }; }
        }
        const message = a.message.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email removed]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[number removed]");
        const content: Handoff = { topic: a.topic, message, fields, consentedSensitiveFields: [...a.consentSensitive].sort() };
        const h = await store.createResource<Handoff>(c, "handoff", content, {}, "previewed");
        const p = await store.issuePreview(c, "handoff", h.id, 1, content);
        await appendSteps(c, a.decisionChainId, [{ step: "confirmation_or_escalation", status: "pending", reason: `PBP handoff preview with fields: ${Object.keys(fields).join(",") || "none"}; consent: ${content.consentedSensitiveFields.join(",") || "none"}`, evidence: [h.id] }]);
        return { handoffId: h.id, exactPackage: content, ...p, sendAvailable: backend.isAvailable("pbp_case_create"), note: "Nothing is shared until you confirm. Only this package is shared." };
      } }),
    defineTool({ name: "commit_pbp_handoff", kind: "commit", permission: "pc.pbp.commit", description: "Send the previewed package to your PBP through the Workday MCP case capability.",
      input: { handoffId: z.string().max(64), previewToken: z.string().max(128), idempotencyKey: key, confirm: z.literal(true), decisionChainId: chainId },
      run: async (a, c) => {
        const h = await store.getResource<Handoff>(c, a.handoffId, "handoff");
        for (const f of h.content.consentedSensitiveFields) await store.setConsent(c, `pbp_handoff:${h.id}:${f}`, true);
        const out = await commitWrite<Handoff>(c, { tool: "commit_pbp_handoff", kind: "handoff", resourceId: h.id, previewToken: a.previewToken, key: a.idempotencyKey, cap: "pbp_case_create", input: { topic: h.content.topic, message: h.content.message, fieldsJson: JSON.stringify(h.content.fields) } });
        if (!out.replayed) await appendSteps(c, a.decisionChainId, [{ step: "confirmation_or_escalation", status: out.status === "succeeded" ? "done" : "blocked", reason: `User confirmed PBP handoff; outcome ${out.status}`, evidence: [h.id] }]);
        return { handoffId: h.id, ...out, exampleData: example };
      } }),
    defineTool({ name: "reconcile_my_pbp_handoff", kind: "commit", permission: "pc.pbp.commit", description: "Resolve a PBP handoff whose outcome is unknown.", input: { handoffId: z.string().max(64), idempotencyKey: key },
      run: (a, c) => reconcile(c, { tool: "commit_pbp_handoff", kind: "handoff", resourceId: a.handoffId, key: a.idempotencyKey, statusCap: "pbp_case_status" }) }),
  ];
  return { tools, roles: ROLES };
}
