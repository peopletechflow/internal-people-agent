# Architecture: Internal People Agent | Workday MCP

This is a Workday MCP server (stdio). Setup: README quick start.

```
MCP client (Claude) --stdio--> src/index.ts
  resolveCaller()   identity from the session (fixture: FIXTURE_USER; live: not implemented -> exit)
  buildMcpServer()  registers only tools the caller's roles allow
  callTool()        strict input schema -> run -> audit (redacted)
src/tools.ts        11 task tools over src/fixtures (example data)
src/core/           identity, policy (deny wins), preview, idempotency, audit, untrusted text
src/adapters.ts     supported-mode table per HR domain
```

## Tool kinds and permissions
- read: `pc.self.read`, `pc.policy.read`, `pc.adapters.read`
- propose (no side effects outside this process): `pc.transfer.propose`, `pc.pbp.propose`
- commit: `pc.transfer.commit`, `pc.pbp.commit`
Roles: `employee` (all), `readonly` (reads), `transfer_freeze` (`!pc.transfer.commit`). Any deny removes the permission regardless of other grants.

## Write flow
1. `preview_*` builds the exact payload, stores a resource with a version, and issues a single-use token bound to kind, tenant, user, resource id, version and SHA-256 of the canonical payload (15 min TTL).
2. `commit_*` requires `confirm: true`, the token and an `idempotencyKey`. It re-reads the stored resource and checks the token against its current version and digest. A revision, another user, another resource, a used or expired token all fail.
3. Idempotency is scoped by tenant, user, tool and key. Concurrent calls share one execution; reusing a key for different content fails.
4. A committed transfer is `submitted_pending_approval`. Approval belongs to the HR business process, never to this tool.

## State
All state is in process memory, which is correct only for the fixture runner. There is no persistent store and no migration because live writes are disabled. Enabling live writes requires a durable store for previews, idempotency and audit first (the upstream repo's Postgres store is the reference).

## Contract proof needed before any live adapter
For each domain, record in this file before enabling it:
1. The exact Workday (or other system) operation, version and endpoint, from official documentation for that tenant (Workday REST API explorer or Workday Web Services operation pages).
2. Proof that the call runs as the signed-in worker with per-user OAuth (no integration-system user or shared token), and that results are limited to that worker.
3. A recorded request and response from a non-production tenant, with field mapping to this tool's output.
4. For writes: the business process that runs, who approves, how a duplicate is detected, and the error shapes.
Known facts: Workday's public REST directory lists Talent Management, Benefits and Staffing areas, but this repo has not validated any benefits, equity or job-change operation for any tenant. Equity grants are commonly held in a separate equity platform; no vendor is integrated.
