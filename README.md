# People Compass

Task-shaped MCP tools that answer an employee's questions about **their own** benefits, equity and HR policy with cited sources, check and request a **team transfer** through the approval process, and prepare a **minimal, consented handoff to their People Business Partner (PBP)**.

Status: **v0.1, fixture-tested.** Every record in `src/fixtures/data.ts` is an invented example. No live HR system is connected. Live mode refuses to start (see capability table).

## Capabilities

| Capability | Tool(s) | Fixture | Live |
| --- | --- | --- | --- |
| Which systems are connected, and how | `list_hr_adapters` | yes | yes (static table) |
| Own benefit elections, enrollment window | `get_my_benefits` | yes | blocked: no proven tenant read |
| Own equity grants and vesting | `get_my_equity` | yes | blocked: no equity platform adapter |
| Policy search with citations | `search_hr_policy` | yes | blocked: no policy source |
| Grounded answer pack (facts + passages + citations + gaps) | `build_answer_pack` | yes | blocked |
| Transfer eligibility pre-check | `check_my_transfer_eligibility` | yes | blocked |
| Transfer request: exact preview, then confirmed submit for approval | `preview_team_transfer_request`, `commit_team_transfer_request` | yes (creates a pending-approval record) | blocked: Workday job-change operation not validated |
| PBP handoff: chosen fields only, consent for sensitive fields, contact details stripped | `preview_pbp_handoff`, `commit_pbp_handoff` | yes (local outbox, no message sent) | blocked |
| Status of my requests | `get_my_requests` | yes | n/a |

Not in scope: coworkers' pay or equity, team rosters, payroll, admin tools, generic API passthrough, automatic transfer completion, financial or tax advice. The server generates no text; the client (for example Claude) writes answers from the answer pack.

## Quick start (fixture mode)

```bash
pnpm install
pnpm check                      # typecheck + tests
FIXTURE_USER=emp_ava pnpm dev   # MCP over stdio as example user emp_ava
```

Example users: `emp_ava` (employee), `emp_ben` (employee with transfer commits frozen, under 12 months tenure), `ro_cy` (read-only), `emp_zed` (another tenant).

Claude Desktop: build (`pnpm build`) and copy `examples/claude_desktop_config.json` into your Claude config, fixing the absolute path. Then load the skill in `skills/people-compass/SKILL.md`.

## Docs
[ARCHITECTURE](docs/ARCHITECTURE.md), [SECURITY](docs/SECURITY.md), [HANDOVER](HANDOVER.md), [CHANGELOG](CHANGELOG.md), [AGENTS](AGENTS.md).

## Provenance
Security primitives (`src/core/`) were adapted from `peopletechflow/workday-mcp-schema` at commit `4bf10b27b025a48b0882d98ab65983fdba271159` (MIT, same copyright holder): preview tokens, idempotency, audit redaction, deny-wins roles. They were rewritten to bind previews to resource, version and content digest. No code, data or secrets beyond these primitives were copied; that repository is unchanged.

## CI
A GitHub Actions workflow is ready in `docs/ci-workflow.example.yml` (install, `pnpm check`, build). Move it to `.github/workflows/ci.yml` from an account with the `workflow` permission to enable it.
