/**
 * Capability ceilings for Workday Agent Gateway mode. The operator policy may bind live tools to these, never widen them.
 * Writes are disabled until a scoped adapter has been validated against a tenant.
 */
import type { Ceiling } from "./core/agentready.js";

export const AGENT_CEILINGS: readonly Ceiling[] = [
  { capability: "worker.self.read", access: "read", permission: "pc.self.read", description: "Read your own worker profile and job data", enabled: true },
  { capability: "benefits.self.read", access: "read", permission: "pc.self.read", description: "Read your own benefit elections", enabled: true },
  { capability: "policy.read", access: "read", permission: "pc.policy.read", description: "Read organization HR policy content (no person data)", enabled: true },
  { capability: "transfer.self.request", access: "write", permission: "pc.transfer.commit", description: "Request a transfer for yourself", enabled: false },
  { capability: "case.self.create", access: "write", permission: "pc.pbp.commit", description: "Open an HR case for yourself", enabled: false },
];
