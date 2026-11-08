# Handover

**Done:** fixture vertical slice for benefits, equity and policy answers with citations, transfer eligibility and request (preview, confirm, pending approval), PBP handoff with consent. 16 tests (`pnpm test`).

**Not done, by design:** any live connector, per-user OAuth sign-in, durable store, remote HTTP transport.

**Next steps, in order:**
1. Pick one tenant and one domain (suggested: benefits read). Complete the contract proof in docs/ARCHITECTURE.md.
2. Add per-user OAuth (reuse the upstream repo's PKCE flow and encrypted token store) and a durable store with migrations for previews, idempotency and audit.
3. Implement that one live adapter behind the existing tool, keeping output shape and source refs.
4. Only then consider the transfer business process, with tenant-specific validation.
