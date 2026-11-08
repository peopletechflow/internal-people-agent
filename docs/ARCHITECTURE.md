# Architecture: Internal People Agent | Workday MCP

This is a Workday MCP server (stdio) that sits in front of an upstream Workday MCP server. Setup: README.

```
src/index.ts         startup: mode, Postgres + migrations, upstream connect, identity, roles, classifier
src/tools.ts         15 task tools, decision chain, write and reconcile flow
src/capabilities.ts  our contracts per capability (inputs, strict output schema)
src/jev.ts           optional TypeSafe Jev intent classifier (@typesafe-ai/sdk)
src/fixture-backend.ts  example data behind the same contracts
src/core/upstream.ts MCP client (official SDK), mapping file, Gateway (tools/list check, arg mapping, response validation)
src/core/store.ts    Postgres store: resources, previews, commits, consents, audit
src/core/backend.ts  Backend interface (LiveBackend over Gateway, FixtureBackend)
db/migrations/       versioned SQL with checksum ledger
```

## Upstream contract
- Connect with `StreamableHTTPClientTransport`, `Authorization: Bearer <your token>`. https only (http allowed on loopback).
- At startup the Gateway reads `tools/list` (all pages). For each capability in the mapping it checks: the tool exists, every mapped argument is in the tool's input schema, every required upstream argument is mapped, and every `from` field is an allowed input of that capability. Otherwise the capability is gated with a reason. Mappings naming unknown capabilities are rejected, so there is no generic passthrough.
- Responses: `structuredContent`, else JSON in the first text block; optional `resultPath`; then strict zod parse that strips unknown fields. `isError` -> `UpstreamToolError` (definitive failure). Transport errors, timeouts and contract mismatches -> `UpstreamUnknownError`.

## Write lifecycle
1. `preview_*` stores the item (versioned) and a single-use preview row holding only the SHA-256 of the token, bound to tenant, user, kind, item, version and content digest. TTL 15 min.
2. `commit_*`: a previous commit with this key returns its stored outcome (never re-sent). Else the capability must be available, the item must be in `previewed`, and the preview is consumed atomically (`update ... where consumed_at is null`).
3. `commits` row claimed with `insert ... on conflict do nothing`, status `pending`, then the upstream write. Outcome `succeeded`, `failed` (upstream said no; item back to draft), or `unknown` (item locked).
4. `reconcile_*` calls the mapped status capability with the idempotency key. Found -> succeeded; not found -> failed and a new key may be used. If no status capability, it stays unknown and tells the user to check Workday.

## Decision chain
Stored as a `decision_chain` resource owned by the caller. Steps are structured records (step, status, reason, evidence, timestamp). Intent sources: client (default) or Jev. Thresholds: `JEV_MIN_CONFIDENCE` (0.6) on the Choice confidence and 0.5 on the scope Noul; below either, or on disagreement or error, the step is `needs_user`. Retrieval only runs capabilities the caller has permission for and that are available.

## What a tenant must prove before mapping a capability
1. The upstream tool runs as the token's worker (Workday security decides visibility), no integration user.
2. Recorded non-production response matches our output schema; record the upstream server version in `verifiedAgainst`.
3. For writes: it starts the Workday business process (not a direct data change), honors the idempotency key or exposes a lookup for the status capability, and documents its error shape.
Known: the upstream repo workday-mcp-schema currently exposes only time-off tools, so none of these capabilities can be mapped to it today.
