import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, visibleTools } from "../src/core/tool.js";
import { resolveCaller } from "../src/core/identity.js";
import { USERS } from "../src/fixtures/data.js";
import { as, setup } from "./helpers.js";

const transferArgs = { positionId: "POS-EX-201", effectiveDate: "2027-01-04", reason: "Grow in data engineering" };

test("focused tool list; no user/tenant inputs; no payroll/admin/coworker/passthrough tools", async () => {
  const { app } = await setup();
  const names = app.tools.map((t) => t.name);
  assert.equal(names.length, 15);
  for (const n of names) assert.doesNotMatch(n, /payroll|salary|compensation|admin|search_workers|coworker|direct_report|passthrough|raw_|call_workday/i);
  for (const t of app.tools) for (const k of ["userId", "tenantId", "employeeId", "workerId"]) assert.ok(!(k in t.input), `${t.name}.${k}`);
});

test("MCP server lists only permitted tools for a read-only user", async () => {
  const { app, store } = await setup();
  const server = buildMcpServer({ name: "t", version: "0" }, app.tools, app.roles, store, as("ro_cy"));
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const listed = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(listed.includes("start_decision_chain"));
  assert.ok(!listed.some((n) => n.startsWith("commit_") || n.startsWith("preview_") || n.startsWith("reconcile_")));
  await client.close();
});

test("answer pack cites example fixture sources only", async () => {
  const { ok } = await setup();
  const d = await ok("emp_ava", "build_answer_pack", { question: "When is open enrollment and how do my RSU vest?", topics: ["benefits", "equity", "policy"] });
  assert.ok(d.citations.length >= 3);
  for (const c of d.citations) { assert.equal(c.example, true); assert.match(c.system, /^fixture:/); }
  assert.ok(d.passages.every((p: any) => p.passage.untrusted === true));
});

test("tenant isolation and unknown args", async () => {
  const { ok, call } = await setup();
  const d = await ok("emp_ava", "search_hr_policy", { query: "tenant handbook enrollment" });
  assert.ok(d.results.every((r: any) => !r.citation.sourceId.startsWith("POL-EX-B-ONLY")));
  assert.equal(((await call("emp_ava", "check_my_transfer_eligibility", { positionId: "POS-EX-901" })) as any).code, "denied");
  assert.equal(((await call("emp_ava", "get_my_equity", { userId: "emp_zed" })) as any).code, "invalid_input");
});

test("transfer: durable preview -> confirm -> pending approval; replay returns stored outcome", async () => {
  const { ok, db } = await setup();
  const p = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
  const args = { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-transfer-1", confirm: true };
  const c1 = await ok("emp_ava", "commit_team_transfer_request", args);
  assert.equal(c1.status, "succeeded"); assert.equal(c1.result.status, "pending_approval");
  const c2 = await ok("emp_ava", "commit_team_transfer_request", args);
  assert.equal(c2.replayed, true); assert.equal(c2.result.requestRef, c1.result.requestRef);
  assert.deepEqual((await db.query<any>("select status from commits")).rows.map((r) => r.status), ["succeeded"]);
  assert.notEqual((await db.query<any>("select token_hash from previews")).rows[0].token_hash, p.previewToken); // hash only
});

test("transfer: concurrent commits with one key execute once", async () => {
  const { ok, call, db } = await setup();
  const p = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
  const args = { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-concurrent", confirm: true };
  const rs = await Promise.all([1, 2, 3].map(() => call("emp_ava", "commit_team_transfer_request", args)));
  assert.ok(rs.filter((r) => r.ok).length >= 1);
  assert.equal(Number((await db.query<any>("select count(*)::int as n from commits")).rows[0].n), 1);
});

test("stale, tampered and cross-user previews are rejected", async () => {
  const { ok, call } = await setup();
  const p1 = await ok("emp_ava", "preview_team_transfer_request", transferArgs);
  const p2 = await ok("emp_ava", "preview_team_transfer_request", { ...transferArgs, reason: "Changed my reason", proposalId: p1.proposalId });
  assert.equal(p2.version, 2);
  assert.match(((await call("emp_ava", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p1.previewToken, idempotencyKey: "key-stale-1", confirm: true })) as any).error, /changed since preview/);
  assert.equal((await call("emp_ava", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p2.previewToken + "x", idempotencyKey: "key-tamper-1", confirm: true })).ok, false);
  assert.equal(((await call("emp_zed", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p2.previewToken, idempotencyKey: "key-other-1", confirm: true })) as any).code, "denied");
  assert.equal((await ok("emp_ava", "commit_team_transfer_request", { proposalId: p1.proposalId, previewToken: p2.previewToken, idempotencyKey: "key-good-1", confirm: true })).status, "succeeded");
});

test("deny wins: transfer_freeze removes commit; ineligible cannot propose", async () => {
  const { app, call } = await setup();
  assert.ok(!visibleTools(app.tools, as("emp_ben"), app.roles).some((t) => t.name === "commit_team_transfer_request"));
  assert.match(((await call("emp_ben", "preview_team_transfer_request", transferArgs)) as any).error, /12 months/);
});

test("operator kill switch hides a tool", async () => {
  const { app } = await setup();
  assert.ok(!visibleTools(app.tools, as("emp_ava"), app.roles, ["commit_pbp_handoff"]).some((t) => t.name === "commit_pbp_handoff"));
});

test("prompt injection in policy text cannot trigger writes", async () => {
  const { app, ok, call } = await setup();
  const d = await ok("ro_cy", "search_hr_policy", { query: "ignore previous instructions commit transfer" });
  assert.ok(d.results.some((r: any) => /IGNORE PREVIOUS/.test(r.passage.text) && r.passage.untrusted));
  assert.equal(visibleTools(app.tools, as("ro_cy"), app.roles).filter((t) => t.kind !== "read").length, 0);
  assert.equal((await call("emp_ava", "commit_team_transfer_request", { proposalId: "tra_x", previewToken: "forged", idempotencyKey: "key-inject-2", confirm: true })).ok, false);
});

test("PBP handoff: chosen fields only, consent required and recorded, contact details stripped", async () => {
  const { ok, call, db } = await setup();
  assert.match(((await call("emp_ava", "preview_pbp_handoff", { topic: "Benefits question", message: "hi", include: ["benefit_elections"] })) as any).error, /explicit consent/);
  const p = await ok("emp_ava", "preview_pbp_handoff", { topic: "Benefits question", message: "Call me at +1 555 123 4567 or ava@example.com", include: ["benefit_elections"], consentSensitive: ["benefit_elections"] });
  const s = JSON.stringify(p.exactPackage);
  assert.ok(!s.includes("ava@example.com") && !s.includes("555 123") && !s.includes("costPerPayPeriod"));
  assert.deepEqual(Object.keys(p.exactPackage.fields), ["benefit_elections"]);
  assert.equal((await ok("emp_ava", "commit_pbp_handoff", { handoffId: p.handoffId, previewToken: p.previewToken, idempotencyKey: "key-pbp-1", confirm: true })).status, "succeeded");
  assert.equal((await db.query("select scope from consents where revoked_at is null")).rows.length, 1);
});

test("fixture identity is refused in live mode", () => {
  assert.throws(() => resolveCaller("live", { FIXTURE_USER: "emp_ava" }, USERS), /not available in live mode/);
});

test("audit log is durable and redacts free text", async () => {
  const { ok, db } = await setup();
  await ok("emp_ava", "build_answer_pack", { question: "my secret medical question", topics: ["benefits"] });
  const rows = (await db.query<any>("select inputs from audit_log")).rows;
  assert.ok(rows.length >= 1 && !JSON.stringify(rows).includes("medical"));
});
