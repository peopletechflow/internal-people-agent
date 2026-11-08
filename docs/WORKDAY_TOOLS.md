# Workday MCP tools: what is known and what is not

| Capability | Upstream tool | Status |
|---|---|---|
| identity | `find_staffing_workers` (WID `30aeb92af72e100063e2955a0eff0000`, user-confirmed) | Tool name known. Input schema not exported: self-service uses `contextInstanceId: me` and caller resolution uses `me: true`, so neither is assumed. Output needs `resultPath`/`fieldMap` taken from a recorded response. |
| benefits_read | `find_latest_employee_enrollment_event` (`c22d04c9cac710000b335f65e7440000`), `get_employee_enrollment_history` (`c5b6e3ca784e1000263ffb9eb0170000`) | Identifiers supplied by the tenant owner. Input and output schemas not exported, so not mapped as verified. |
| equity_read, policy lookup, PBP handoff | none supplied | No tool. Stays gated. |
| transfer_submit | none suitable | `initiate_change_job` is a manager/HR action. The gateway refuses to map it to this self-service capability, and refuses any mapping that pins a worker or target argument to a constant. |

`examples/workday-mcp-mapping.example.json` is a placeholder. Its `REPLACE_` names are gated at startup. No capability in this repo has been run against a live tenant.

The WIDs above are catalog tool identifiers (the IDs MCP Explorer and the ASOR Agent Resource Search API list), supplied and confirmed by the tenant owner. They are not worker, personal or credential data. Workday's docs don't say whether they differ between tenants.

The native agent instruction for those two benefits tools is `native/ipa-benefits-skill/SKILL.md`. It is not `skills/internal-people-agent/SKILL.md`, and it does not change the MCP tool contract. The server still does not map `benefits_read` as verified. The native instruction tells the agent not to repeat raw event titles or descriptors, not to treat event status as carrier coverage, and not to infer "no changes" unless both returned records actually contain the election values being compared.

**Agent Gateway mode:** per Workday's change policy, tool names and schemas change without versioning and are for AI agents only. At runtime the server therefore uses live discovery plus the operator-approved tool policy (`AGENT_TOOL_POLICY_PATH`), not this table, and fixed capability mappings are off. The table is reference material for writing that policy.
