import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const NATIVE = new URL("../native/ipa-benefits-skill/SKILL.md", import.meta.url);
const SHA = "5a1ae17f965eee321ef304c6a169da63be0f5a072828820e0658acb7cafed4df";

test("native benefits skill bytes, tools and WIDs stay exactly as supplied", () => {
  const raw = readFileSync(NATIVE);
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA);
  const text = raw.toString("utf8");
  assert.match(text, /^name: ipa-benefits-skill$/m);
  assert.match(text, /^allowed-tools:\n  - find_latest_employee_enrollment_event\n  - get_employee_enrollment_history$/m);
  assert.match(text, /name: find_latest_employee_enrollment_event\n    wid: "c22d04c9cac710000b335f65e7440000"/);
  assert.match(text, /name: get_employee_enrollment_history\n    wid: "c5b6e3ca784e1000263ffb9eb0170000"/);
  assert.match(text, /Never repeat a raw event title, display name or descriptor/);
  assert.match(text, /Report an event's status as the status of the event, never as coverage/);
  assert.match(text, /compare only election values that appear in both results/);
  assert.match(text, /Never conclude "no changes" only because there are no newer events/);
  assert.doesNotMatch(text, /https?:\/\/|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|Bearer |password|api[_-]?key/i);
});

test("external MCP skill is not the native benefits contract", () => {
  const mcp = readFileSync(new URL("../skills/internal-people-agent/SKILL.md", import.meta.url), "utf8");
  assert.doesNotMatch(mcp, /tool-wids:|find_latest_employee_enrollment_event|get_employee_enrollment_history/);
  assert.match(mcp, /build_answer_pack/);
});
