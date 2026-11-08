# Security: Internal People Agent | Workday MCP

- **Identity.** Live: the caller is the worker the upstream Workday MCP server reports for the user's own token (`identity` capability). Fixture: `FIXTURE_USER`, refused in live. No tool accepts user, tenant or worker ids; unknown keys are rejected.
- **No shared credentials.** The token file is the user's own (stdio is one process per user), must be `chmod 600`, and is never logged. There is no fallback token.
- **Roles.** From `ROLE_MAP_PATH` per `tenant:worker`; no entry means no access. Deny wins. Tool lists are filtered per caller. `DISABLED_TOOLS` and `DISABLED_CAPABILITIES` are kill switches.
- **Allowlist.** Only capabilities in `src/capabilities.ts`, each mapped to one verified upstream tool with fixed argument mapping. Responses are schema-validated and stripped.
- **Writes.** Preview then commit, bound and single-use, `confirm: true`, idempotency key, durable outcome, unknown outcomes never auto-retried. Transfers start a business process only.
- **PBP handoff.** Only fields the user lists; benefit and equity fields need explicit consent, recorded in `consents`; contact details stripped; nothing sent before confirm.
- **Decision chain.** Structured, owned by the caller, no hidden reasoning stored. Classifier output (Claude or Jev) only chooses which permitted reads to run; it cannot unlock tools.
- **Jev (optional).** Sends the question text only to TypeSafe (`api.typesafe.ai`), with an API key from a `chmod 600` file. Off by default. Review TypeSafe's terms before enabling for employee data.
- **Untrusted content.** Policy passages and questions are wrapped `{ untrusted: true }`. Tested with injected instructions.
- **Audit.** Postgres `audit_log`, free text redacted.
