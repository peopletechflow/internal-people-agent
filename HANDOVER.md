# Handover: Internal People Agent | Workday MCP

**Done (v0.2):** upstream Workday MCP gateway, live identity and role map, Postgres store and migrations, unknown-outcome writes with reconcile, decision chain with optional Jev, fixture mode on the same contracts. 32 tests (`pnpm test`), all with fixture data or test doubles.

**Not verified:** any real tenant upstream tool, the `pg` driver against a real Postgres server (tests use PGlite), and any live Jev call.

**Next steps:**
1. Pick the upstream Workday MCP server for one tenant and run `list_hr_adapters` against a sandbox with a mapping for `identity` and `benefits_read`.
2. Record the contract proof in docs/ARCHITECTURE.md and fill `verifiedAgainst`.
3. Run the suite against a real Postgres (`DATABASE_URL`) before production.
4. Add writes one at a time (transfer, then PBP case) with a status capability for reconcile.
5. If you enable Jev, evaluate thresholds on real, consented sample questions.

## Security boundaries (2026-11-08 hardening)
- **Subject arguments.** Any upstream argument that picks a person (worker, employee, user, target, recipient, contextInstanceId, me, wid, ...) must be `{"caller":"workerId"}`, which is filled from the authenticated identity at call time and never from input. Exceptions: `contextInstanceId:"me"` or `me:true` as constants, and inputs a capability lists in `objectInputs`, which its tool resolves server-side (for example the feedback recipient comes from the caller's own feedback request). Anything else is gated at startup. Record IDs (goalId, eventId, reviewId) are not subjects; Workday authorizes them under the caller's own token.
- **Prohibited tools.** Manager, HR and payroll tools (`initiate_change_job`, `approve_business_process_event_step`, `request_payroll_input`, `initiate_performance_review_for_employee`) are refused for every capability, matched case- and punctuation-insensitively. This list does not prove anything about unknown tools. The explicit mapping allowlist plus tools/list contract checks remain the boundary.
- **Response size.** Each upstream HTTP response body (JSON or SSE) is counted while it streams and cancelled after 2 MB, before the SDK parses it. A second 1 MB check runs on the parsed result. There is no limit yet on connection count, idle SSE time, or total memory across concurrent streams, so deployments should also set gateway or proxy connection and stream limits.
