# Internal People Agent | Workday MCP

> **Status: experimental.** This is an independent project and is not affiliated with or endorsed by Workday. It has not been run against a production Workday tenant, and live adapters only work for capabilities your tenant mapping verifies (everything else is gated). Fixture data is invented. Security: see [SECURITY.md](SECURITY.md). Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). CI is a template in `docs/ci-workflow.example.yml` and is not active until it is installed.


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

## Workday Agent Gateway mode (the documented Workday path)

Based on Workday's public docs, read 2026-11-08:
- Agent-Ready MCP Tools: https://developer.workday.com/documentation/GUID-949559e7-10c3-438a-abb2-e452c23d9da8-enHYPHENus/AgentReadyMCPTools
- Connect an External Agent with Workday MCP: https://developer.workday.com/documentation/GUID-03605c39-71d3-4314-bf71-97f274df457c-enHYPHENus/ConnectanExternalAgentwithWorkdayMCP
- Developer Guidelines & Change Policy: https://developer.workday.com/documentation/GUID-04498a6d-10ba-4a41-a917-9fa668641b8d-enHYPHENus/WorkdayAgentReadyMCPToolsDeveloperGuidelinesChangePolicy
- Discover Available Agent-Ready MCP Tools (MCP Explorer, Agent Resource Search): https://developer.workday.com/documentation/GUID-f86470b2-4283-48e6-8d7e-18c91c470878-enHYPHENus
- Configure External Agents / Authenticate Agents to Agent Gateway: https://doc.workday.com/admin-guide/en-us/workday-ai/agents/external-agents/configure-external-agents.html and https://doc.workday.com/admin-guide/en-us/workday-ai/agents/onboard-partner-agent-to-agent-gateway.html

Operator steps in Workday (this repository cannot do them): set up ASOR; register the agent and its skills and tools; configure it (enable skills, choose security groups, set the redirect URI); copy the one-time client ID and secret; activate it, which creates the Agent System User (ASU); and configure security policies for the agent's skills.

Runtime:
1. Run `pnpm asu:login` (with `WORKDAY_AGENT_GATEWAY`, `WORKDAY_TENANT_ALIAS`, `ASU_CLIENT_ID`, `ASU_CLIENT_SECRET_FILE`, `ASU_REDIRECT_URI` and `ASU_SESSION_FILE` set). It walks through the authorization code flow with PKCE: `GET https://{gateway}/auth/authorize/{tenant}`, then `POST https://{gateway}/auth/oauth2/{tenant}/token`. The session file is written atomically with mode 600, and symlinks or loose permissions are refused.
2. Run `pnpm agent-tools:snapshot` (read only). It lists the tools this agent can see, with contract fingerprints. Write `AGENT_TOOL_POLICY_PATH` from it after review; `examples/agent-tool-policy.example.json` shows the format.
3. `MODE=live pnpm start`. The server connects to `https://{gateway}/{tenant}/mcp` with the ASU token and resolves the worker through the policy's identity tool. It then exposes `workday_list_agent_tools` and one tool per enabled capability ceiling from `src/agent-capabilities.ts` (for example `workday_benefits_self_read`). There is no generic call tool, and Agent Gateway writes are off by default. See [docs/AGENT_GATEWAY_SECURITY.md](docs/AGENT_GATEWAY_SECURITY.md).

Behaviour:
- Discovery is paginated. The tool list is refreshed on `notifications/tools/list_changed`, after a 5-minute TTL, and always right before a commit.
- A renamed, removed or schema-changed tool turns off until it is re-approved. Description rewrites are not treated as changes.
- If a write tool's contract changes between preview and commit, nothing is sent.
- Person fields at any depth are filled from the authenticated worker. Schemas that cannot be bound safely are refused, and record ids must come from your own earlier results. The manager, HR and payroll denylist is defence in depth only.
- The fixed decision-chain capabilities (benefits, transfer and the others) are off in this mode; the decision chain and the Jev option still run, and Claude remains the default, because Workday's tools are for agents only and must not be hard-coded.

Access tokens last 60 minutes (documented) and are refreshed before expiry. The refresh request shape is not in the public docs, so it uses the standard OAuth `refresh_token` grant. Any refresh failure ends the session and requires signing in again; nothing falls back to another credential. Revoking access is a Workday-side action (deactivate the agent). Ambient (x509 JWT) agents are not implemented. Not yet run against a live tenant.

Direct mapping mode (`WORKDAY_MCP_URL` + a fixed token file) is for other MCP servers you run yourself, outside production only. A fixed bearer token is not an ASU session.
