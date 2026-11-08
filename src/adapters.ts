/**
 * Explicit adapter boundary for HR systems. Only the fixture adapters exist. A live adapter
 * must be added per tenant after its contract is proven (docs/ARCHITECTURE.md); until then
 * live mode refuses to start.
 */
export type AdapterMode = "fixture" | "live_unproven" | "not_implemented";
export const ADAPTERS: { domain: string; system: string; read: AdapterMode; write: AdapterMode; note: string }[] = [
  { domain: "benefits", system: "Workday (Benefits)", read: "fixture", write: "not_implemented", note: "Live read needs a proven tenant contract (e.g. a validated Workday Web Services or REST read for the signed-in worker). Enrollment changes stay in Workday." },
  { domain: "equity", system: "Equity administration platform (not Workday)", read: "fixture", write: "not_implemented", note: "Equity grant data usually lives in a separate equity platform. No live adapter for any vendor is implemented." },
  { domain: "policy", system: "Policy repository (tenant documents)", read: "fixture", write: "not_implemented", note: "Live needs an approved document source with version and effective dates." },
  { domain: "transfer", system: "Workday (job change business process)", read: "fixture", write: "live_unproven", note: "Commit creates a request for the business process to approve. Live submission is blocked until the tenant operation is validated." },
  { domain: "pbp_handoff", system: "HR case queue", read: "not_implemented", write: "live_unproven", note: "Fixture writes to a local outbox only. No messages are sent to any system." },
];
