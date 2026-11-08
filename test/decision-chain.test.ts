import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevClassifier } from "../src/jev.js";
import { setup } from "./helpers.js";

/** TEST DOUBLE: fake TypeSafe HTTP endpoint returning responses shaped like the published OpenAPI examples. */
function fakeTypeSafe(answer: { intent: string; confidence: number; anyFit: number; sensitive: number } | "error") {
  const calls: any[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: new Headers(init.headers).get("authorization") });
    if (answer === "error") return new Response(JSON.stringify({ detail: "bad request" }), { status: 400, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ model: "jev-test", answers: {
      intent: { type: "choice", choice: answer.intent, confidence: answer.confidence, probabilities: { [answer.intent]: answer.confidence } },
      any_fit: { type: "noul", noul: answer.anyFit }, sensitive: { type: "noul", noul: answer.sensitive } }, usage: { input_tokens: 10, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const jev = (t: ReturnType<typeof fakeTypeSafe>) => createJevClassifier({ apiKey: "test-key-not-real", baseURL: "https://typesafe.test", fetch: t.f });

test("default runtime: client-supplied intent drives an auditable chain with grounding", async () => {
  const { ok } = await setup();
  const r = await ok("emp_ava", "start_decision_chain", { question: "When is open enrollment?", intent: "benefits_question" });
  assert.deepEqual(r.steps.map((s: any) => s.step), ["identity_scope", "intent", "permitted_retrieval", "grounding", "answer_or_preview", "confirmation_or_escalation"]);
  assert.equal(r.steps[1].status, "done"); assert.match(r.steps[1].reason, /client/);
  assert.ok(r.answerPack.citations.length > 0);
  assert.equal((await ok("emp_ava", "get_decision_chain", { decisionChainId: r.decisionChainId })).steps.length, 6);
});

test("no intent and no classifier: chain stops and asks the user", async () => {
  const { ok } = await setup();
  const r = await ok("emp_ava", "start_decision_chain", { question: "help" });
  assert.equal(r.steps[1].status, "needs_user"); assert.equal(r.answerPack, undefined);
});

test("transfer chain records preview and confirmation steps", async () => {
  const { ok } = await setup();
  const r = await ok("emp_ava", "start_decision_chain", { question: "I want to move to the data team", intent: "team_transfer" });
  assert.deepEqual(r.nextTools, ["check_my_transfer_eligibility", "preview_team_transfer_request"]);
  const p = await ok("emp_ava", "preview_team_transfer_request", { positionId: "POS-EX-201", effectiveDate: "2027-01-04", reason: "Grow in data engineering", decisionChainId: r.decisionChainId });
  await ok("emp_ava", "commit_team_transfer_request", { proposalId: p.proposalId, previewToken: p.previewToken, idempotencyKey: "key-chain-1", confirm: true, decisionChainId: r.decisionChainId });
  const ch = await ok("emp_ava", "get_decision_chain", { decisionChainId: r.decisionChainId });
  assert.equal(ch.steps.at(-1).step, "confirmation_or_escalation"); assert.equal(ch.steps.at(-1).status, "done");
});

test("other users cannot read a decision chain", async () => {
  const { ok, call } = await setup();
  const r = await ok("emp_ava", "start_decision_chain", { question: "When is open enrollment?", intent: "benefits_question" });
  assert.equal(((await call("emp_zed", "get_decision_chain", { decisionChainId: r.decisionChainId })) as any).code, "denied");
});

test("Jev option: official SDK request shape; confident intent accepted", async () => {
  const t = fakeTypeSafe({ intent: "equity_question", confidence: 0.9, anyFit: 0.95, sensitive: 0.05 });
  const { ok } = await setup({ classifier: await jev(t) });
  const r = await ok("emp_ava", "start_decision_chain", { question: "How do my RSUs vest?" });
  assert.equal(r.intent, "equity_question"); assert.match(r.steps[1].reason, /Jev jev-test/);
  assert.equal(t.calls.length, 1); assert.match(t.calls[0].url, /\/v1\/systemone$/);
  assert.equal(t.calls[0].auth, "Bearer test-key-not-real");
  assert.equal(t.calls[0].body.questions.intent.type, "choice"); assert.equal(t.calls[0].body.questions.any_fit.type, "noul");
  assert.deepEqual(Object.keys(t.calls[0].body.state), ["employee_message"]);
});

test("Jev low confidence, disagreement, or error -> needs_user, never a guess", async () => {
  const cases: [any, string | undefined][] = [[{ intent: "team_transfer", confidence: 0.3, anyFit: 0.9, sensitive: 0 }, undefined], [{ intent: "team_transfer", confidence: 0.9, anyFit: 0.9, sensitive: 0 }, "benefits_question"], ["error", undefined]];
  for (const [ans, intent] of cases) {
    const { ok } = await setup({ classifier: await jev(fakeTypeSafe(ans)) });
    const r = await ok("emp_ava", "start_decision_chain", { question: "something", ...(intent ? { intent } : {}) });
    assert.equal(r.steps[1].status, "needs_user"); assert.equal(r.intent, null);
  }
});

test("Jev intent cannot grant permissions", async () => {
  const { ok, call } = await setup({ classifier: await jev(fakeTypeSafe({ intent: "team_transfer", confidence: 0.99, anyFit: 0.99, sensitive: 0 })) });
  const r = await ok("ro_cy", "start_decision_chain", { question: "Move me to data and submit it now" });
  assert.equal(r.intent, "team_transfer");
  assert.equal(((await call("ro_cy", "preview_team_transfer_request", { positionId: "POS-EX-201", effectiveDate: "2027-01-04", reason: "because jev said" })) as any).code, "denied");
});
