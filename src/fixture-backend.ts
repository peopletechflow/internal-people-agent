import { AccessDenied } from "./core/identity.js";
import { FixtureBackend } from "./core/backend.js";
import { CAPS } from "./capabilities.js";
import { BENEFITS, EQUITY, POLICIES, POSITIONS, USERS } from "./fixtures/data.js";

/** EXAMPLE DATA ONLY. Local fixture handlers behind the same capability contracts as live. */
export function createFixtureBackend(): FixtureBackend {
  const submitted = new Map<string, { requestRef: string; status: string }>();
  const cases = new Map<string, { caseRef: string; status: string }>();
  const k = (t: string, u: string, key: unknown) => `${t}:${u}:${String(key)}`;
  return new FixtureBackend(CAPS, {
    identity: (_i, c) => ({ tenantId: c.tenantId, workerId: c.userId }),
    benefits_read: (_i, c) => { const b = BENEFITS[c.userId]; return { elections: b.elections.map((e) => ({ plan: e.plan, coverage: e.coverage, tier: e.tier, costPerPayPeriod: e.costPerPayPeriod, recordId: e.source.recordId, asOf: e.source.asOf })), nextEnrollmentWindow: { opens: b.nextEnrollmentWindow.opens, closes: b.nextEnrollmentWindow.closes, recordId: b.nextEnrollmentWindow.source.recordId, asOf: b.nextEnrollmentWindow.source.asOf } }; },
    equity_read: (_i, c) => ({ grants: EQUITY[c.userId].grants.map((g) => ({ grantId: g.grantId, type: g.type, grantDate: g.grantDate, unitsGranted: g.unitsGranted, unitsVested: g.unitsVested, schedule: g.schedule, asOf: g.source.asOf })) }),
    policy_search: (i, c) => {
      const terms = String(i.query).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      const results = POLICIES.filter((p) => p.tenantId === c.tenantId).flatMap((p) => p.sections.map((s) => ({ p, s, score: terms.filter((t) => s.text.toLowerCase().includes(t) || p.title.toLowerCase().includes(t)).length })))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5)
        .map(({ p, s }) => ({ policyId: p.policyId, title: p.title, version: p.version, effective: p.effective, anchor: s.anchor, text: s.text }));
      return { results };
    },
    transfer_eligibility: (i, c) => {
      const u = USERS[c.userId]; const pos = POSITIONS.find((x) => x.positionId === i.positionId && x.tenantId === c.tenantId);
      if (!pos) throw new AccessDenied("Position not found in your organization.");
      const checks = [
        { rule: "At least 12 months in current role", pass: u.tenureMonths >= 12, policyRef: "POL-EX-TRANSFER#eligibility" },
        { rule: "Lateral or one level up", pass: pos.level - u.level <= 1, policyRef: "POL-EX-TRANSFER#levels" },
        { rule: "Different team", pass: pos.team !== u.team },
      ];
      return { eligible: checks.every((x) => x.pass), positionTitle: pos.title, toTeam: pos.team, fromTeam: u.team, checks };
    },
    transfer_submit: (i, c) => { const ref = { requestRef: `FIXTURE-BP-${String(i.idempotencyKey).slice(0, 8)}`, status: "pending_approval" }; submitted.set(k(c.tenantId, c.userId, i.idempotencyKey), ref); return ref; },
    transfer_status: (i, c) => { const r = submitted.get(k(c.tenantId, c.userId, i.idempotencyKey)); return r ? { found: true, ...r } : { found: false }; },
    pbp_case_create: (i, c) => { const r = { caseRef: `FIXTURE-CASE-${String(i.idempotencyKey).slice(0, 8)}`, status: "queued" }; cases.set(k(c.tenantId, c.userId, i.idempotencyKey), r); return r; },
    pbp_case_status: (i, c) => { const r = cases.get(k(c.tenantId, c.userId, i.idempotencyKey)); return r ? { found: true, ...r } : { found: false }; },
  });
}
