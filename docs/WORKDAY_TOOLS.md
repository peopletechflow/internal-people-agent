# Workday MCP tools: what is known and what is not

| Capability | Upstream tool | Status |
|---|---|---|
| identity | `find_staffing_workers` (WID `30aeb92af72e100063e2955a0eff0000`, supplied by the tenant owner for their tenant) | Tool name known. Input schema not exported: self-service uses `contextInstanceId: me` and caller resolution uses `me: true`, so neither is assumed. Output needs `resultPath`/`fieldMap` taken from a recorded response. |
| benefits_read | `find_latest_employee_enrollment_event` (`c22d04c9cac710000b335f65e7440000`), `get_employee_enrollment_history` (`c5b6e3ca784e1000263ffb9eb0170000`) | Identifiers supplied by the tenant owner. Input and output schemas not exported, so not mapped as verified. |
| equity_read, policy lookup, PBP handoff | none supplied | No tool. Stays gated. |
| transfer_submit | none suitable | `initiate_change_job` is a manager/HR action. The gateway refuses to map it to this self-service capability, and refuses any mapping that pins a worker or target argument to a constant. |

`examples/workday-mcp-mapping.example.json` is a placeholder. Its `REPLACE_` names are gated at startup. No capability in this repo has been run against a live tenant.

WIDs are tenant-specific metadata, not secrets. Whether to publish the ones above is the repository owner's decision (see SECURITY.md and the README).
