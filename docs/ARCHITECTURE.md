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

## Status
| | Implemented and tested | Live tenant verified |
| --- | --- | --- |
| Upstream Workday MCP client (official SDK, tools/list check, strict response schemas, per-user bearer token) | yes, against test-double MCP servers (in-memory and loopback HTTP) | **no** |
| Identity from upstream `identity` capability, roles from role map | yes | **no** |
| Durable Postgres state with migrations; unknown-outcome writes and reconcile | yes (PGlite, the Postgres engine in WASM; `pg` driver path not run in CI) | **no** |
| Decision chain (Claude intent by default, Jev optional) | yes (Jev against a test double of the published API) | Jev: **no live call made** |
| Fixture mode (example data, same contracts) | yes | n/a |

## Capabilities (each one is gated until mapped and verified)
| Capability | Tools | Fixture | Live |
| --- | --- | --- | --- |
| `identity` (required to start live) | all | example users | via mapped upstream tool |
| `benefits_read` | `get_my_benefits`, answer packs | yes | when mapped |
| `equity_read` | `get_my_equity`, answer packs | yes | when mapped (often a separate equity platform behind your Workday MCP) |
| `policy_search` | `search_hr_policy`, answer packs | yes | when mapped |
| `transfer_eligibility` | `check_my_transfer_eligibility`, preview | yes | when mapped |
| `transfer_submit`, `transfer_status` | `commit_team_transfer_request`, `reconcile_my_transfer_request` | yes | when mapped; starts the business process, never completes a transfer |
| `pbp_case_create`, `pbp_case_status` | `commit_pbp_handoff`, `reconcile_my_pbp_handoff` | yes | when mapped |

`list_hr_adapters` shows, per capability, whether it is available and why not.

## Decision chain steps
`start_decision_chain` records, per request: `identity_scope` -> `intent` -> `permitted_retrieval` -> `grounding` -> `answer_or_preview` -> `confirmation_or_escalation`, each with a status, a short reason and evidence refs (source ids, digests). Preview and commit tools append steps when given `decisionChainId`. It records decisions and their evidence, not model reasoning text.

**Default:** Claude classifies intent and passes it. **Optional Jev:** set `DECISION_CLASSIFIER=jev`. Jev is TypeSafe's System One model: it answers typed questions (a Choice for intent, Nouls for "fits scope" and "contains sensitive details") with probabilities and confidence. It does not write answers, call tools or chat, so Claude still drafts every answer. Low confidence, disagreement with Claude, or an API error makes the chain stop and ask the user. Jev output never grants permissions.

## Provenance
`src/core/` adapts security ideas from `peopletechflow/workday-mcp-schema` at `4bf10b27b025a48b0882d98ab65983fdba271159` (MIT, same owner): preview then commit, idempotency, audit redaction, deny-wins roles, Postgres migrations. Rewritten here with durable bound previews and explicit unknown outcomes. That repository is unchanged.
