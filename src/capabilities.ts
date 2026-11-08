import { z } from "zod";
import { IDENTITY_CAPABILITY, type CapabilityDef } from "./core/upstream.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}/);
const short = (n = 200) => z.string().min(1).max(n);

/**
 * Task capabilities this server needs from an upstream Workday MCP server. These are OUR
 * contracts. A tenant maps each one to a tool on their upstream server (see
 * examples/workday-mcp-mapping.example.json). Unmapped or mismatched capabilities are gated.
 */
export const CAPS: Record<string, CapabilityDef> = {
  identity: IDENTITY_CAPABILITY,
  benefits_read: { kind: "read", inputs: [], description: "Caller's own benefit elections", output: z.object({
    elections: z.array(z.object({ plan: short(), coverage: short(), tier: short().optional(), costPerPayPeriod: short(40).optional(), recordId: short(128), asOf: date }).strip()).max(50),
    nextEnrollmentWindow: z.object({ opens: date, closes: date, recordId: short(128), asOf: date }).strip().optional() }).strip() },
  equity_read: { kind: "read", inputs: [], description: "Caller's own equity grants", output: z.object({
    grants: z.array(z.object({ grantId: short(64), type: short(40), grantDate: date, unitsGranted: z.number().nonnegative(), unitsVested: z.number().nonnegative(), schedule: short(300).optional(), asOf: date }).strip()).max(100) }).strip() },
  policy_search: { kind: "read", inputs: ["query"], description: "Tenant policy passages", output: z.object({
    results: z.array(z.object({ policyId: short(64), title: short(), version: short(40), effective: date, anchor: short(80), text: z.string().min(1).max(4000) }).strip()).max(10) }).strip() },
  transfer_eligibility: { kind: "read", inputs: ["positionId"], description: "Caller's eligibility for an open position", output: z.object({
    eligible: z.boolean(), positionTitle: short(), toTeam: short(), fromTeam: short(),
    checks: z.array(z.object({ rule: short(300), pass: z.boolean(), policyRef: short(128).optional() }).strip()).max(20) }).strip() },
  transfer_submit: { kind: "write", inputs: ["positionId", "effectiveDate", "reason", "idempotencyKey"], description: "Start the job-change business process for the caller", output: z.object({
    requestRef: short(128), status: z.enum(["submitted", "pending_approval", "in_progress"]) }).strip() },
  transfer_status: { kind: "read", inputs: ["idempotencyKey"], description: "Find a transfer request by idempotency key", output: z.object({
    found: z.boolean(), requestRef: short(128).optional(), status: short(40).optional() }).strip() },
  pbp_case_create: { kind: "write", inputs: ["topic", "message", "fieldsJson", "idempotencyKey"], description: "Open an HR case for the caller's PBP", output: z.object({
    caseRef: short(128), status: z.enum(["open", "queued"]) }).strip() },
  pbp_case_status: { kind: "read", inputs: ["idempotencyKey"], description: "Find a PBP case by idempotency key", output: z.object({
    found: z.boolean(), caseRef: short(128).optional(), status: short(40).optional() }).strip() },
};
