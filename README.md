# Internal People Agent | Workday MCP

An independent, task-shaped **Workday MCP** server and Claude skill. Not affiliated with, endorsed by, or certified by Workday, Inc.; Workday is a trademark of Workday, Inc.

Employees ask about **their own** benefits, equity and HR policy and get cited answers, request a **team transfer** through the approval process, and hand off to their **People Business Partner (PBP)** with minimal, consented data. Every request runs through an **auditable decision chain**.

## How it connects
```
Claude (default runtime) --stdio MCP--> Internal People Agent --MCP (Streamable HTTP, your token)--> your upstream Workday MCP server
                                         |-- Postgres: previews, commits, consents, decision chains, audit
                                         `-- optional: TypeSafe Jev for intent classification
```
Live mode calls a Workday MCP server you already run or have access to, through an allowlisted capability mapping. It does not call Workday REST or SOAP itself, and it ships no tenant mapping because no upstream tool has been verified against a real tenant yet.

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

## Decision chain
`start_decision_chain` records, per request: `identity_scope` -> `intent` -> `permitted_retrieval` -> `grounding` -> `answer_or_preview` -> `confirmation_or_escalation`, each with a status, a short reason and evidence refs (source ids, digests). Preview and commit tools append steps when given `decisionChainId`. It records decisions and their evidence, not model reasoning text.

**Default:** Claude classifies intent and passes it. **Optional Jev:** set `DECISION_CLASSIFIER=jev`. Jev is TypeSafe's System One model: it answers typed questions (a Choice for intent, Nouls for "fits scope" and "contains sensitive details") with probabilities and confidence. It does not write answers, call tools or chat, so Claude still drafts every answer. Low confidence, disagreement with Claude, or an API error makes the chain stop and ask the user. Jev output never grants permissions.

## Quick start (fixture mode, no accounts needed)
```bash
pnpm install
pnpm check                      # typecheck + 32 tests
FIXTURE_USER=emp_ava pnpm dev   # stdio MCP server, example data, embedded Postgres
```
Claude Desktop: `pnpm build`, then use `examples/claude_desktop_config.json` and load `skills/internal-people-agent/SKILL.md`.

## Live setup
1. Postgres: create a database and set `DATABASE_URL`. Migrations in `db/migrations` run at startup.
2. Get your own access token for your upstream Workday MCP server; save it to a file with `chmod 600`; set `WORKDAY_MCP_URL` and `WORKDAY_MCP_TOKEN_FILE`.
3. Copy `examples/workday-mcp-mapping.example.json`, map each capability to a real upstream tool after checking its input schema and output, set `WORKDAY_MCP_MAPPING_PATH`.
4. Copy `examples/role-map.example.json`, set `ROLE_MAP_PATH`.
5. `MODE=live pnpm start`. Startup fails if identity is not mapped. Other unmapped or mismatched capabilities are gated individually.
6. Optional Jev: TypeSafe API key in a `chmod 600` file, `DECISION_CLASSIFIER=jev`, `TYPESAFE_API_KEY_FILE`. Only the question text is sent to TypeSafe.

## Docs
[ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY](docs/SECURITY.md), [HANDOVER](HANDOVER.md), [CHANGELOG](CHANGELOG.md), [AGENTS](AGENTS.md).

## Provenance
`src/core/` adapts security ideas from `peopletechflow/workday-mcp-schema` at `4bf10b27b025a48b0882d98ab65983fdba271159` (MIT, same owner): preview then commit, idempotency, audit redaction, deny-wins roles, Postgres migrations. Rewritten here with durable bound previews and explicit unknown outcomes. That repository is unchanged.

## CI
A workflow is ready in `docs/ci-workflow.example.yml`. Move it to `.github/workflows/ci.yml` from an account with the `workflow` permission.
