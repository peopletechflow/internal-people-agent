import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCaller, type Caller } from "../src/core/identity.js";
import { callTool, visibleTools, buildMcpServer } from "../src/core/tool.js";
import { Audit } from "../src/core/audit.js";
import { USERS } from "../src/fixtures/data.js";
import { createInternalPeopleAgent } from "../src/tools.js";

const as = (u: string): Caller => resolveCaller("fixture", { FIXTURE_USER: u }, USERS);
function setup(mode: "fixture" | "live" = "fixture") {
  const app = createInternalPeopleAgent(mode); const audit = new Audit();
  const call = async (u: string, name: string, args: unknown = {}) => callTool(app.tools, app.roles, audit, as(u), name, args);
  const ok = async (u: string, name: string, args: unknown = {}) => { const r = await call(u, name, args); assert.ok(r.ok, JSON.stringify(r)); return (r as { data: any }).data; };
  return { app, audit, call, ok };
}
const transferArgs = { positionId: "POS-EX-201", effectiveDate: "2027-01-04", reason: "Grow in data engineering" };

test("focused tool list: no payroll, admin, compensation, coworker or generic passthrough tools", async () => {
  const { app } = setup();
  const names = app.tools.map((t) => t.name);
  assert.equal(names.length, 11);
  for (const n of names) assert.doesNotMatch(n, /payroll|salary|compensation|admin|search_workers|coworker|direct_report|passthrough|raw_/i);
  for (const t of app.tools) assert.ok(!("userId" in t.input) && !("tenantId" in t.input) && !("employeeId" in t.input), t.name);
  for (const n of ["get_payslips", "search_workers", "workday_request", "get_team_compensation"]) assert.ok(!names.includes(n));
});

test("MCP stdio server lists only permitted tools (readonly user has no write tools)", async () => {
  const { app } = setup();
  const server = buildMcpServer({ name: "t", version: "0" }, app.tools, app.roles, new Audit(), as("ro_cy"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(listed, ["build_answer_pack", "check_my_transfer_eligibility", "get_my_benefits", "get_my_equity", "get_my_requests", "list_hr_adapters", "search_hr_policy"]);
  const r = await client.callTool({ name: "get_my_benefits", arguments: {} });
  assert.ok(!r.isError);
  await client.close();
});

test("answer pack cites only real fixture sources and marks them as examples", async () => {
  const { ok } = setup();
  const d = await ok("emp_ava", "build_answer_pack", { question: "When is open enrollment and how do my RSU vest?", topics: ["benefits", "equity", "policy"] });
  assert.ok(d.citations.length >= 3);
  for (const c of d.citations) { assert.equal(c.example, true); assert.ok(c.sourceId && c.asOf); }
  assert.ok(d.passages.every((p: any) => p.passage.untrusted === true));
  assert.match(d.disclaimer, /not financial, tax, or legal advice/);
});

test("tenant isolation: policies and positions of another tenant are invisible", async () => {
  const { ok, call } = setup();
  const d = await ok("emp_ava", "search_hr_policy", { query: "tenant handbook enrollment" });
  assert.ok(d.results.every((r: any) => !r.citation.sourceId.startsWith("POL-EX-B-ONLY")));
  const r = await call("emp_ava", "check_my_transfer_eligibility", { positionId: "POS-EX-901" });
  assert.equal(r.ok, false); assert.equal((r as any).code, "denied");
});

test("unknown arguments (e.g. userId) are rejected, not used", async () => {
  const { call } = setup();
  const r = await call("emp_ava", "get_my_equity", { userId: "emp_zed" });
  assert.equal(r.ok, false); assert.equal((r as any).code, "invalid_input");
});

test("transfer: preview -> confirm creates a pending approval, not a completed transfer; replay is idempotent", async () => {
  const { ok } = setup();
  const p = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
  assert.deepEqual(p.exactRequest, { positionId: "POS-EX-201", fromTeam: "Platform", toTeam: "Data", effectiveDate: "2027-01-04", reason: transferArgs.reason });
  const args = { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-transfer-1", confirm: true };
  const c1 = await ok("emp_ava", "commit_team_transfer_request", args);
  assert.equal(c1.status, "submitted_pending_approval"); assert.equal(c1.replayed, false);
  const c2 = await ok("emp_ava", "commit_team_transfer_request", args);
  assert.equal(c2.replayed, true); assert.equal(c2.businessProcessRef, c1.businessProcessRef);
});

test("transfer: concurrent commits with one key run once", async () => {
  const { ok, app } = setup();
  const p = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
  const args = { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-concurrent", confirm: true };
  const rs = await Promise.all([1, 2, 3].map(() => ok("emp_ava", "commit_team_transfer_request", args)));
  assert.equal(new Set(rs.map((r) => r.businessProcessRef)).size, 1);
  assert.equal([...app.proposals.values()].filter((x) => x.status === "submitted_pending_approval").length, 1);
});

test("stale preview after revision, tampered token, and other user's token are rejected", async () => {
  const { ok, call } = setup();
  const p1 = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
  const p2 = await ok("emp_ava", "preview_team_transfer_request", { ...transferArgs, reason: "Changed my reason", proposalId: p1.proposalId });
  assert.equal(p2.version, 2);
  const stale = await call("emp_ava", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p1.previewToken, idempotencyKey: "key-stale-1", confirm: true });
  assert.equal(stale.ok, false); assert.match((stale as any).error, /changed since preview/);
  const tampered = await call("emp_ava", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p2.previewToken + "x", idempotencyKey: "key-tamper-1", confirm: true });
  assert.equal(tampered.ok, false);
  const other = await call("emp_zed", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p2.previewToken, idempotencyKey: "key-other-1", confirm: true });
  assert.equal(other.ok, false); assert.equal((other as any).code, "denied");
  const good = await ok("emp_ava", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p2.previewToken, idempotencyKey: "key-good-1", confirm: true });
  assert.equal(good.status, "submitted_pending_approval");
});

test("deny wins over grant: transfer_freeze removes commit; ineligible user cannot propose", async () => {
  const { app, call } = setup();
  assert.ok(!visibleTools(app.tools, as("emp_ben"), app.roles).some((t) => t.name === "commit_team_transfer_request"));
  const r = await call("emp_ben", "preview_team_transfer_request", transferArgs);
  assert.equal(r.ok, false); assert.match((r as any).error, /12 months/);
  const r2 = await call("emp_ben", "commit_team_transfer_request", { proposalId: "x", previewToken: "y", idempotencyKey: "key-ben-123", confirm: true });
  assert.equal((r2 as any).code, "denied");
});

test("prompt injection in policy text cannot trigger writes or grant tools", async () => {
  const { app, ok, call } = setup();
  const d = await ok("ro_cy", "search_hr_policy", { query: "ignore previous instructions commit transfer" });
  assert.ok(d.results.some((r: any) => /IGNORE PREVIOUS/.test(r.passage.text) && r.passage.untrusted));
  assert.equal(visibleTools(app.tools, as("ro_cy"), app.roles).filter((t) => t.kind !== "read").length, 0);
  const r = await call("ro_cy", "commit_team_transfer_request", { proposalId: "x", previewToken: "y", idempotencyKey: "key-inject-1", confirm: true });
  assert.equal((r as any).code, "denied");
  const r2 = await call("emp_ava", "commit_team_transfer_request", { proposalId: "tp_any", previewToken: "forged", idempotencyKey: "key-inject-2", confirm: true });
  assert.equal(r2.ok, false);
});

test("PBP handoff: minimal fields, sensitive needs consent, contact details stripped, nothing shared before confirm", async () => {
  const { ok, call, app } = setup();
  const noConsent = await call("emp_ava", "preview_pbp_handoff", { topic: "Benefits question", message: "hi", include: ["benefit_elections"] });
  assert.equal(noConsent.ok, false); assert.match((noConsent as any).error, /explicit consent/);
  const p = await ok("emp_ava", "preview_pbp_handoff", { topic: "Benefits question", message: "Call me at +1 555 123 4567 or ava@example.com", include: ["benefit_elections"], consentSensitive: ["benefit_elections"] });
  assert.deepEqual(Object.keys(p.exactPackage.fields), ["benefit_elections"]);
  assert.ok(!JSON.stringify(p.exactPackage).includes("ava@example.com") && !JSON.stringify(p.exactPackage).includes("555 123"));
  assert.ok(!JSON.stringify(p.exactPackage).includes("costPerPayPeriod"));
  assert.equal(app.outbox.length, 0);
  await ok("emp_ava", "commit_pbp_handoff", { handoffId: p.handoffId, previewToken: p.previewToken, idempotencyKey: "key-pbp-1", confirm: true });
  assert.equal(app.outbox.length, 1);
});

test("live mode fails closed: no sign-in and no live reads or writes", async () => {
  assert.throws(() => resolveCaller("live", { FIXTURE_USER: "emp_ava" }, USERS), /not available in live mode/);
  const { call } = setup("live");
  const r = await call("emp_ava", "get_my_benefits");
  assert.equal((r as any).code, "live_unsupported");
});

test("no outbound network calls during a full fixture flow", async () => {
  const orig = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("blocked"); }) as typeof fetch;
  try {
    const { ok } = setup();
    await ok("emp_ava", "build_answer_pack", { question: "enrollment", topics: ["benefits", "policy"] });
    const p = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
    await ok("emp_ava", "commit_team_transfer_request", { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-net-1", confirm: true });
  } finally { globalThis.fetch = orig; }
  assert.equal(calls, 0);
});

test("audit log redacts free text", async () => {
  const { ok, audit } = setup();
  await ok("emp_ava", "build_answer_pack", { question: "my secret medical question", topics: ["benefits"] });
  assert.ok(!JSON.stringify(audit.events).includes("medical"));
});
