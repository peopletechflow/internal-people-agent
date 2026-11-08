import { z } from "zod";
import { randomUUID } from "node:crypto";
import { AccessDenied, type Caller, type Mode, LiveUnsupported } from "./core/identity.js";
import { requireOwner, type RoleTable } from "./core/policy.js";
import { PreviewStore, digest } from "./core/preview.js";
import { Idempotency } from "./core/idempotency.js";
import { defineTool, type ToolDef } from "./core/tool.js";
import { untrusted, UNTRUSTED_NOTE } from "./core/untrusted.js";
import { BENEFITS, EQUITY, POLICIES, POSITIONS, USERS, type SourceRef } from "./fixtures/data.js";
import { ADAPTERS } from "./adapters.js";

export const ROLES: RoleTable = {
  employee: ["pc.self.read", "pc.policy.read", "pc.adapters.read", "pc.transfer.propose", "pc.transfer.commit", "pc.pbp.propose", "pc.pbp.commit"],
  readonly: ["pc.self.read", "pc.policy.read", "pc.adapters.read"],
  transfer_freeze: ["!pc.transfer.commit"],
};

const DISCLAIMER = "Information from your records and published policy, not financial, tax, or legal advice. Check the cited source for the final word.";
const SENSITIVE = new Set(["benefit_elections", "equity_grants"]);
const HANDOFF_FIELDS = ["tenure_and_team", "benefit_elections", "equity_grants", "transfer_proposal"] as const;

type Proposal = { proposalId: string; tenantId: string; userId: string; version: number; content: { positionId: string; fromTeam: string; toTeam: string; effectiveDate: string; reason: string }; status: "draft" | "submitted_pending_approval"; bpRef?: string };
type Handoff = { handoffId: string; tenantId: string; userId: string; version: number; content: { topic: string; pbpId: string; message: string; fields: Record<string, unknown>; consentedSensitiveFields: string[] }; status: "draft" | "queued_fixture" };

export function createPeopleCompass(mode: Mode, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const previews = new PreviewStore();
  const idem = new Idempotency();
  const proposals = new Map<string, Proposal>();
  const handoffs = new Map<string, Handoff>();
  const outbox: Handoff[] = [];

  const live = (what: string) => { if (mode === "live") throw new LiveUnsupported(what); };
  const me = (c: Caller) => { const u = USERS[c.userId]; if (!u || u.tenantId !== c.tenantId) throw new AccessDenied("Unknown caller."); return u; };
  const policies = (c: Caller) => POLICIES.filter((p) => p.tenantId === c.tenantId);
  const position = (c: Caller, id: string) => { const p = POSITIONS.find((x) => x.positionId === id && x.tenantId === c.tenantId); if (!p) throw new AccessDenied("Position not found in your organization."); return p; };
  const cite = (p: (typeof POLICIES)[number], anchor: string): SourceRef => ({ sourceId: `${p.policyId}#${anchor}`, system: "fixture:policy-repo", recordId: `${p.policyId} v${p.version}`, asOf: p.effective, example: true });

  const searchPolicy = (c: Caller, query: string, limit = 5) => {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    return policies(c).flatMap((p) => p.sections.map((s) => ({ p, s, score: terms.filter((t) => s.text.toLowerCase().includes(t) || p.title.toLowerCase().includes(t)).length })))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
      .map(({ p, s }) => ({ title: p.title, passage: untrusted(s.text), citation: cite(p, s.anchor) }));
  };

  const eligibility = (c: Caller, positionId: string) => {
    const u = me(c); const pos = position(c, positionId);
    const pol = policies(c).find((p) => p.policyId === "POL-EX-TRANSFER");
    const checks = [
      { rule: "At least 12 months in current role", pass: u.tenureMonths >= 12, citation: pol && cite(pol, "eligibility") },
      { rule: "Lateral or one level up", pass: pos.level - u.level <= 1, citation: pol && cite(pol, "levels") },
      { rule: "Different team", pass: pos.team !== u.team, citation: undefined },
      { rule: "No open transfer request", pass: ![...proposals.values()].some((p) => p.userId === c.userId && p.tenantId === c.tenantId && p.status === "submitted_pending_approval"), citation: undefined },
    ];
    return { positionId, title: pos.title, toTeam: pos.team, eligible: checks.every((x) => x.pass), checks, note: "Eligibility here is a pre-check. Managers and HR decide through the business process." };
  };

  const tools: ToolDef[] = [
    defineTool({ name: "list_hr_adapters", kind: "read", permission: "pc.adapters.read", description: "Which HR systems are connected and in which mode (fixture, live_unproven, not_implemented).", input: {},
      run: () => ({ mode, adapters: ADAPTERS }) }),
    defineTool({ name: "get_my_benefits", kind: "read", permission: "pc.self.read", description: "Your own benefit elections and next enrollment window, with sources.", input: {},
      run: (_a, c) => { live("Benefits read"); me(c); return { ...BENEFITS[c.userId], retrievedAt: now().toISOString(), disclaimer: DISCLAIMER }; } }),
    defineTool({ name: "get_my_equity", kind: "read", permission: "pc.self.read", description: "Your own equity grants and vesting schedule, with sources. Not tax or financial advice.", input: {},
      run: (_a, c) => { live("Equity read"); me(c); return { ...EQUITY[c.userId], retrievedAt: now().toISOString(), disclaimer: DISCLAIMER }; } }),
    defineTool({ name: "search_hr_policy", kind: "read", permission: "pc.policy.read", description: "Search your organization's HR policies. Returns quoted passages with citations.", input: { query: z.string().min(2).max(200) },
      run: (a, c) => { live("Policy search"); return { note: UNTRUSTED_NOTE, results: searchPolicy(c, a.query) }; } }),
    defineTool({ name: "build_answer_pack", kind: "read", permission: "pc.self.read", description: "Collect your own facts and matching policy passages for a question, each with a source and date, so the answer can cite them. Says what is missing instead of guessing.",
      input: { question: z.string().min(3).max(500), topics: z.array(z.enum(["benefits", "equity", "policy"])).min(1).max(3) },
      run: (a, c) => {
        live("Answer pack"); me(c);
        const facts: { topic: string; fact: unknown; citation: SourceRef }[] = [];
        if (a.topics.includes("benefits")) { const b = BENEFITS[c.userId]; for (const e of b.elections) facts.push({ topic: "benefits", fact: { plan: e.plan, coverage: e.coverage, tier: e.tier, costPerPayPeriod: e.costPerPayPeriod }, citation: e.source }); facts.push({ topic: "benefits", fact: { nextEnrollmentWindow: { opens: b.nextEnrollmentWindow.opens, closes: b.nextEnrollmentWindow.closes } }, citation: b.nextEnrollmentWindow.source }); }
        if (a.topics.includes("equity")) for (const g of EQUITY[c.userId].grants) facts.push({ topic: "equity", fact: { grantId: g.grantId, type: g.type, unitsGranted: g.unitsGranted, unitsVested: g.unitsVested, schedule: g.schedule }, citation: g.source });
        const passages = searchPolicy(c, a.question, 4);
        const citations = [...facts.map((f) => f.citation), ...passages.map((p) => p.citation)];
        return { question: untrusted(a.question), facts, passages, citations, gaps: facts.length + passages.length === 0 ? ["No matching records or policy passages. Ask your PBP."] : [], instructions: "Answer only from facts and passages. Cite sourceId for each claim. " + UNTRUSTED_NOTE, retrievedAt: now().toISOString(), disclaimer: DISCLAIMER };
      } }),
    defineTool({ name: "check_my_transfer_eligibility", kind: "read", permission: "pc.self.read", description: "Pre-check your eligibility for an open position in your organization.", input: { positionId: z.string().max(64) },
      run: (a, c) => { live("Transfer eligibility"); return eligibility(c, a.positionId); } }),
    defineTool({ name: "preview_team_transfer_request", kind: "propose", permission: "pc.transfer.propose", description: "Draft a transfer request and show the exact request that would be sent for approval. Pass proposalId to revise; revising invalidates the old preview.",
      input: { positionId: z.string().max(64), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().min(5).max(1000), proposalId: z.string().max(64).optional() },
      run: (a, c) => {
        const el = eligibility(c, a.positionId);
        if (!el.eligible) throw new AccessDenied(`Not eligible: ${el.checks.filter((x) => !x.pass).map((x) => x.rule).join("; ")}`);
        const content = { positionId: a.positionId, fromTeam: me(c).team, toTeam: el.toTeam, effectiveDate: a.effectiveDate, reason: a.reason };
        let p: Proposal;
        if (a.proposalId) { const ex = proposals.get(a.proposalId); if (!ex) throw new AccessDenied("Proposal not found."); requireOwner(c, ex); if (ex.status !== "draft") throw new AccessDenied("Proposal already submitted."); p = { ...ex, version: ex.version + 1, content }; }
        else p = { proposalId: `tp_${randomUUID()}`, tenantId: c.tenantId, userId: c.userId, version: 1, content, status: "draft" };
        proposals.set(p.proposalId, p);
        return { proposalId: p.proposalId, version: p.version, exactRequest: content, ...previews.issue(c, "team_transfer", p.proposalId, p.version, content), whatHappensNext: "Confirming starts the transfer business process. Your manager, the receiving manager, and HR still approve it. It is not a completed transfer." };
      } }),
    defineTool({ name: "commit_team_transfer_request", kind: "commit", permission: "pc.transfer.commit", description: "Submit a previewed transfer request for approval. Needs the preview token, confirm=true and an idempotency key.",
      input: { proposalId: z.string().max(64), previewToken: z.string().max(128), idempotencyKey: z.string().max(128), confirm: z.literal(true) },
      run: async (a, c) => {
        const p = proposals.get(a.proposalId); if (!p) throw new AccessDenied("Proposal not found."); requireOwner(c, p);
        const prior = idem.peek(c, "commit_team_transfer_request", a.idempotencyKey);
        const d = prior ? digest(p.content) : previews.consume(c, a.previewToken, "team_transfer", p.proposalId, p.version, p.content);
        live("Transfer submission to Workday");
        const r = await idem.run(c, "commit_team_transfer_request", a.idempotencyKey, d, async () => {
          if (p.status !== "draft") throw new AccessDenied("Proposal already submitted.");
          p.status = "submitted_pending_approval"; p.bpRef = `FIXTURE-BP-${p.proposalId.slice(3, 11)}`;
          return { proposalId: p.proposalId, status: p.status, businessProcessRef: p.bpRef, fixture: true, note: "Fixture only. Pending manager and HR approval." };
        });
        return { ...r.result, replayed: r.replayed };
      } }),
    defineTool({ name: "get_my_requests", kind: "read", permission: "pc.self.read", description: "Status of your own transfer requests and PBP handoffs.", input: {},
      run: (_a, c) => ({ transfers: [...proposals.values()].filter((p) => p.userId === c.userId && p.tenantId === c.tenantId).map((p) => ({ proposalId: p.proposalId, version: p.version, status: p.status, businessProcessRef: p.bpRef })), handoffs: [...handoffs.values()].filter((h) => h.userId === c.userId && h.tenantId === c.tenantId).map((h) => ({ handoffId: h.handoffId, status: h.status })) }) }),
    defineTool({ name: "preview_pbp_handoff", kind: "propose", permission: "pc.pbp.propose", description: "Prepare a minimal summary for your People Business Partner. Only fields you list are included; benefit_elections and equity_grants also need your explicit consent in consentSensitive. Contact details are removed from the message.",
      input: { topic: z.string().min(3).max(120), message: z.string().max(2000), include: z.array(z.enum(HANDOFF_FIELDS)).max(4), consentSensitive: z.array(z.enum(["benefit_elections", "equity_grants"])).max(2).default([]), transferProposalId: z.string().max(64).optional() },
      run: (a, c) => {
        const u = me(c);
        const missing = a.include.filter((f) => SENSITIVE.has(f) && !a.consentSensitive.includes(f as never));
        if (missing.length) throw new AccessDenied(`Sensitive fields need explicit consent: ${missing.join(", ")}`);
        const fields: Record<string, unknown> = {};
        for (const f of a.include) {
          if (f === "tenure_and_team") fields[f] = { team: u.team, tenureMonths: u.tenureMonths };
          if (f === "benefit_elections") fields[f] = BENEFITS[c.userId].elections.map((e) => ({ plan: e.plan, coverage: e.coverage }));
          if (f === "equity_grants") fields[f] = EQUITY[c.userId].grants.map((g) => ({ grantId: g.grantId, type: g.type }));
          if (f === "transfer_proposal") { const p = a.transferProposalId && proposals.get(a.transferProposalId); if (!p) throw new AccessDenied("transfer_proposal needs your transferProposalId."); requireOwner(c, p); fields[f] = { proposalId: p.proposalId, toTeam: p.content.toTeam, status: p.status }; }
        }
        const message = a.message.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email removed]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[number removed]");
        const content = { topic: a.topic, pbpId: u.pbpId, message, fields, consentedSensitiveFields: [...a.consentSensitive].sort() };
        const h: Handoff = { handoffId: `ho_${randomUUID()}`, tenantId: c.tenantId, userId: c.userId, version: 1, content, status: "draft" };
        handoffs.set(h.handoffId, h);
        return { handoffId: h.handoffId, exactPackage: content, ...previews.issue(c, "pbp_handoff", h.handoffId, 1, content), note: "Nothing is shared until you confirm. Only this package is shared." };
      } }),
    defineTool({ name: "commit_pbp_handoff", kind: "commit", permission: "pc.pbp.commit", description: "Send the previewed package to your PBP queue (fixture outbox only).",
      input: { handoffId: z.string().max(64), previewToken: z.string().max(128), idempotencyKey: z.string().max(128), confirm: z.literal(true) },
      run: async (a, c) => {
        const h = handoffs.get(a.handoffId); if (!h) throw new AccessDenied("Handoff not found."); requireOwner(c, h);
        const prior = idem.peek(c, "commit_pbp_handoff", a.idempotencyKey);
        const d = prior ? digest(h.content) : previews.consume(c, a.previewToken, "pbp_handoff", h.handoffId, h.version, h.content);
        live("PBP case creation");
        const r = await idem.run(c, "commit_pbp_handoff", a.idempotencyKey, d, async () => { h.status = "queued_fixture"; outbox.push(structuredClone(h)); return { handoffId: h.handoffId, status: h.status, fixture: true }; });
        return { ...r.result, replayed: r.replayed };
      } }),
  ];
  return { tools, roles: ROLES, outbox, proposals };
}
