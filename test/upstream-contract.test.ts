/**
 * Adapter protocol contract tests. The upstream below is a TEST DOUBLE: an MCP server built with
 * the official SDK returning realistic, invented responses. It proves our client, mapping,
 * schema verification and outcome handling; it does not prove any real tenant's tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connectUpstream, Gateway, MappingFile } from "../src/core/upstream.js";
import { LiveBackend } from "../src/core/backend.js";
import { liveCaller } from "../src/core/identity.js";
import { CAPS } from "../src/capabilities.js";
import { setup } from "./helpers.js";

type Mode = { submit: "ok" | "error" | "malformed" | "hang" };
const txt = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
async function fakeWorkdayMcp(mode: Mode) {
  const s = new McpServer({ name: "test-double-workday-mcp", version: "0" });
  const submitted = new Map<string, string>(); const seenArgs: any[] = [];
  s.registerTool("whoami", { inputSchema: {} }, async () => txt({ tenantId: "test_tenant", workerId: "W-100", displayName: "dropped" }));
  s.registerTool("get_my_benefit_elections", { inputSchema: {} }, async () => ({ content: [], structuredContent: { data: { elections: [{ plan: "Test Medical", coverage: "Employee", recordId: "BE-1", asOf: "2026-10-01", ssn: "should be stripped" }] } } }));
  s.registerTool("find_open_position_eligibility", { inputSchema: { position_id: z.string() } }, async () => txt({ eligible: true, positionTitle: "Test Role", toTeam: "Data", fromTeam: "Platform", checks: [{ rule: "Test rule", pass: true }] }));
  s.registerTool("submit_job_change_request", { inputSchema: { position_id: z.string(), effective_date: z.string(), justification: z.string(), idempotency_key: z.string(), source: z.string() } }, async (a) => {
    seenArgs.push(a);
    if (mode.submit === "error") return { isError: true, ...txt({ message: "Position closed" }) };
    if (mode.submit === "malformed") { submitted.set(a.idempotency_key, "JC-9"); return txt({ ok: true }); }
    if (mode.submit === "hang") { submitted.set(a.idempotency_key, "JC-7"); await new Promise((r) => setTimeout(r, 1000)); }
    submitted.set(a.idempotency_key, "JC-1"); return txt({ requestRef: "JC-1", status: "pending_approval" });
  });
  s.registerTool("get_job_change_by_key", { inputSchema: { idempotency_key: z.string() } }, async (a) => txt(submitted.has(a.idempotency_key) ? { found: true, requestRef: submitted.get(a.idempotency_key), status: "pending_approval" } : { found: false }));
  s.registerTool("get_payslips", { inputSchema: {} }, async () => txt({}));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  return { up: await connectUpstream({ transport: b }), seenArgs };
}

const mapping = MappingFile.parse({ version: 1, capabilities: {
  identity: { tool: "whoami" },
  benefits_read: { tool: "get_my_benefit_elections", resultPath: "data" },
  transfer_eligibility: { tool: "find_open_position_eligibility", args: { position_id: { from: "positionId" } } },
  transfer_submit: { tool: "submit_job_change_request", args: { position_id: { from: "positionId" }, effective_date: { from: "effectiveDate" }, justification: { from: "reason" }, idempotency_key: { from: "idempotencyKey" }, source: { const: "internal-people-agent" } } },
  transfer_status: { tool: "get_job_change_by_key", args: { idempotency_key: { from: "idempotencyKey" } } },
  equity_read: { tool: "get_my_equity_grants" },
  policy_search: { tool: "find_open_position_eligibility", args: { position_id: { from: "query" }, extra_arg: { const: 1 } } },
} });

async function live(mode: Mode, timeoutMs = 500) {
  const { up, seenArgs } = await fakeWorkdayMcp(mode);
  const gw = await Gateway.create(up, mapping, CAPS, { timeoutMs });
  const caller = liveCaller(await gw.invoke("identity", {}), { "test_tenant:*": { roles: ["employee"] } });
  const s = await setup({ backend: new LiveBackend(gw), caller: () => caller });
  return { ...s, gw, seenArgs };
}
const prev = { positionId: "P-1", effectiveDate: "2027-02-01", reason: "Test reason" };

test("tools/list verification gates unmapped, missing and schema-mismatched capabilities only", async () => {
  const { gw } = await live({ submit: "ok" });
  const st = Object.fromEntries(gw.capabilities().map((c) => [c.capability, c]));
  assert.equal(st.identity.status, "available"); assert.equal(st.transfer_submit.status, "available");
  assert.match(st.equity_read.reason!, /not found in tools\/list/);
  assert.match(st.policy_search.reason!, /unknown args: extra_arg/);
  assert.match(st.pbp_case_create.reason!, /no tenant mapping/);
});

test("identity comes from the upstream token owner; extra fields are dropped", async () => {
  const { gw } = await live({ submit: "ok" });
  assert.deepEqual(await gw.invoke("identity", {}), { tenantId: "test_tenant", workerId: "W-100" });
  assert.throws(() => liveCaller({ tenantId: "t", workerId: "w" }, {}), /No roles/);
});

test("live read: structuredContent + resultPath, strict schema strips extra fields, source is the upstream tool; gated read errors cleanly", async () => {
  const { ok, call } = await live({ submit: "ok" });
  const b = await ok("x", "get_my_benefits");
  assert.equal(b.elections[0].plan, "Test Medical"); assert.equal(b.elections[0].ssn, undefined);
  assert.equal(b.source, "workday-mcp:get_my_benefit_elections"); assert.equal(b.exampleData, false);
  assert.equal(((await call("x", "get_my_equity")) as any).code, "gated");
});

test("live write: allowlisted arg mapping with constants; success", async () => {
  const { ok, seenArgs } = await live({ submit: "ok" });
  const p = await ok("x", "preview_team_transfer_request", prev);
  assert.equal(p.submitAvailable, true);
  assert.equal((await ok("x", "commit_team_transfer_request", { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-live-1", confirm: true })).status, "succeeded");
  assert.deepEqual(seenArgs[0], { position_id: "P-1", effective_date: "2027-02-01", justification: "Test reason", idempotency_key: "key-live-1", source: "internal-people-agent" });
});

test("upstream isError -> failed (definitive)", async () => {
  const { ok } = await live({ submit: "error" });
  const p = await ok("x", "preview_team_transfer_request", prev);
  const c = await ok("x", "commit_team_transfer_request", { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-live-2", confirm: true });
  assert.equal(c.status, "failed"); assert.match(c.result.error, /Position closed/);
});

test("malformed response -> unknown, never re-sent; reconcile resolves from the upstream record", async () => {
  const { ok, seenArgs } = await live({ submit: "malformed" });
  const p = await ok("x", "preview_team_transfer_request", prev);
  const args = { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-live-3", confirm: true };
  assert.equal((await ok("x", "commit_team_transfer_request", args)).status, "unknown");
  const again = await ok("x", "commit_team_transfer_request", args);
  assert.equal(again.status, "unknown"); assert.equal(again.replayed, true); assert.equal(seenArgs.length, 1);
  const r = await ok("x", "reconcile_my_transfer_request", { proposalId: p.proposalId, idempotencyKey: "key-live-3" });
  assert.equal(r.status, "succeeded"); assert.equal(r.result.requestRef, "JC-9");
});

test("timeout -> unknown outcome, then reconcile", async () => {
  const { ok } = await live({ submit: "hang" }, 100);
  const p = await ok("x", "preview_team_transfer_request", prev);
  assert.equal((await ok("x", "commit_team_transfer_request", { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-live-4", confirm: true })).status, "unknown");
  assert.equal((await ok("x", "reconcile_my_transfer_request", { proposalId: p.proposalId, idempotencyKey: "key-live-4" })).status, "succeeded");
});

test("unmapped write is gated before the preview token is spent", async () => {
  const { ok, call } = await live({ submit: "ok" });
  const p = await ok("x", "preview_pbp_handoff", { topic: "Question", message: "hello", include: [] });
  assert.equal(p.sendAvailable, false);
  assert.equal(((await call("x", "commit_pbp_handoff", { handoffId: p.handoffId, previewToken: p.previewToken, idempotencyKey: "key-live-5", confirm: true })) as any).code, "gated");
});

test("mapping is strict and refuses unknown capabilities (no passthrough)", async () => {
  assert.throws(() => MappingFile.parse({ version: 1, capabilities: { x: { tool: "t", oops: 1 } } }));
  const { up } = await fakeWorkdayMcp({ submit: "ok" });
  await assert.rejects(Gateway.create(up, MappingFile.parse({ version: 1, capabilities: { call_anything: { tool: "get_payslips" } } }), CAPS), /unknown capability/);
});

test("Streamable HTTP transport sends the caller's bearer token (loopback test double)", async () => {
  const http = await import("node:http");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const seen: string[] = [];
  const srv = http.createServer(async (req, res) => {
    seen.push(String(req.headers.authorization));
    const s = new McpServer({ name: "test-double", version: "0" });
    s.registerTool("whoami", { inputSchema: {} }, async () => txt({ tenantId: "t1", workerId: "w1" }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await s.connect(t);
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    await t.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    const up = await connectUpstream({ url: `http://127.0.0.1:${port}/mcp`, accessToken: "test-user-token" });
    const gw = await Gateway.create(up, MappingFile.parse({ version: 1, capabilities: { identity: { tool: "whoami" } } }), CAPS);
    assert.deepEqual(await gw.invoke("identity", {}), { tenantId: "t1", workerId: "w1" });
    assert.ok(seen.length > 0 && seen.every((h) => h === "Bearer test-user-token"));
    await up.close();
  } finally { srv.close(); }
  await assert.rejects(connectUpstream({ url: "http://example.com/mcp", accessToken: "x" }), /https/);
});

test("transfer write cannot be backed by a manager/HR tool or pinned to another worker", async () => {
  const server = new McpServer({ name: "up", version: "0" });
  for (const n of ["initiate_change_job", "self_transfer"]) server.tool(n, "", { workerId: z.string().optional(), positionId: z.string(), effectiveDate: z.string(), reason: z.string() }, async () => ({ content: [{ type: "text", text: "{}" }] }));
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
  const up = await connectUpstream({ transport: b });
  const args = { positionId: { from: "positionId" }, effectiveDate: { from: "effectiveDate" }, reason: { from: "reason" } };
  const g1 = await Gateway.create(up, MappingFile.parse({ version: 1, capabilities: { transfer_submit: { tool: "initiate_change_job", args } } }), CAPS);
  assert.match(g1.capabilities().find((s) => s.capability === "transfer_submit")!.reason!, /not allowed/);
  const g2 = await Gateway.create(up, MappingFile.parse({ version: 1, capabilities: { transfer_submit: { tool: "self_transfer", args: { ...args, workerId: { const: "W-OTHER" } } } } }), CAPS);
  assert.match(g2.capabilities().find((s) => s.capability === "transfer_submit")!.reason!, /constant/);
  await up.close();
});

test("identity without tenant uses WORKDAY_TENANT; mismatch refuses", async () => {
  const { withTenant } = await import("../src/core/identity.js");
  assert.deepEqual(withTenant({ workerId: "W1" }, "t1"), { tenantId: "t1", workerId: "W1" });
  assert.throws(() => withTenant({ workerId: "W1", tenantId: "t2" }, "t1"), /does not match/);
  assert.throws(() => withTenant({ workerId: "W1" }), /no tenant/);
});
