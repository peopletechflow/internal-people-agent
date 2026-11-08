# Handover: Internal People Agent | Workday MCP

**Done (v0.2):** upstream Workday MCP gateway, live identity and role map, Postgres store and migrations, unknown-outcome writes with reconcile, decision chain with optional Jev, fixture mode on the same contracts. 32 tests (`pnpm test`), all with fixture data or test doubles.

**Not verified:** any real tenant upstream tool, the `pg` driver against a real Postgres server (tests use PGlite), and any live Jev call.

**Next steps:**
1. Pick the upstream Workday MCP server for one tenant and run `list_hr_adapters` against a sandbox with a mapping for `identity` and `benefits_read`.
2. Record the contract proof in docs/ARCHITECTURE.md and fill `verifiedAgainst`.
3. Run the suite against a real Postgres (`DATABASE_URL`) before production.
4. Add writes one at a time (transfer, then PBP case) with a status capability for reconcile.
5. If you enable Jev, evaluate thresholds on real, consented sample questions.
