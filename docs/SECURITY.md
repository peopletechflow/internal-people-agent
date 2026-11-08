# Security model

- **Identity from the session, never from arguments.** Tool schemas are strict and contain no user, tenant or employee id. Extra keys are rejected.
- **Fixture identity is not authentication.** `FIXTURE_USER` selects an example record for local testing. `MODE=live` exits at startup because per-user sign-in is not implemented. There is no shared service-token fallback.
- **Least privilege tool lists.** Each caller sees only the tools their roles allow; deny wins.
- **Own data only.** Reads return the caller's records; positions and policies are filtered to the caller's tenant; stored proposals and handoffs check owner tenant and user.
- **Human confirmation for every write.** Preview then commit with a bound, single-use token and `confirm: true`. Commits create requests for approval; nothing completes a transfer.
- **PBP handoff is minimal and consented.** Only fields the user lists are included; benefit and equity fields also need explicit consent; emails and phone numbers are stripped from the message; nothing leaves before confirm. In fixture mode, confirm writes to a local outbox only.
- **Untrusted text.** Policy passages and the user's question are returned as `{ untrusted: true, text }`. No tool reads roles, approvals or instructions from content. Tests include an injected instruction in a policy.
- **Audit.** Each call is logged with free text, names and secrets redacted (`AUDIT_LOG_PATH`, file mode 0600).
- **No outbound calls.** The fixture runner makes no network requests (tested by stubbing `fetch`).
- **Not advice.** Answers carry a disclaimer and cite sources and dates.

Report issues privately to the repository owner.
