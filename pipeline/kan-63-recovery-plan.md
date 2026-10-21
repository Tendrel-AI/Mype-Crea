# KAN-63 / KAN-18 implementation plan

Status: implementation and decision record draft. The user authorized reversible local defaults on 2026-10-20; production operating values remain open until reviewed. This file does not claim KAN-63 or KAN-18 acceptance.

## Current evidence

- `agent_tasks` in PostgreSQL is the source of truth; Redis Pub/Sub only wakes the logo worker.
- `runtime.ts` republishes due pending logo tasks immediately after the worker subscribes and every 60 seconds, with a maximum of 100 pending tasks per active tenant per pass.
- `claimById` atomically changes only a pending row to `in_progress`; duplicate wake-ups cannot claim the same row twice.
- Worker settlement persists task, deliverables, dispatch marker, and completion event together through tenant/user-scoped repositories. External image calls cannot be assumed to execute exactly once.
- KAN-57 must land before recovery changes, since whole-snapshot writes can otherwise lose a dispatch or completion marker.

## Commit order after the existing KAN-14 commits

1. KAN-61 policy and KAN-14 CI corrections, if the audit finds gaps.
2. KAN-17 two-tenant isolation suite wired into CI.
3. KAN-62 repository-local topology record and reproducible local environment.
4. KAN-57 concurrent state write correction and focused regression.
5. KAN-63 operational policy record, then KAN-18 periodic pending-task recovery and focused tests.
6. KAN-15 deployment and recovery verification against the agreed pilot environment.

The primary agent reviews and creates these commits in order. Agents leave changes uncommitted and preserve the unrelated KAN-70 work already present in the tree.

## Recovery design to validate

1. Discover active tenants from persisted organization metadata. For each tenant, use `systemRepos(tenant)` under the existing tenant transaction/RLS boundary.
2. Periodically list bounded, due `pending` logo tasks and republish only `{taskId, tenantId, agentId}`. Keep the worker's canonical row lookup and atomic claim as the authority. Repeat scans after startup; log scan failures and retry on the next scan.
3. Keep one scan loop per process and stop it through the runtime test hook. Use reversible local defaults of a 60-second interval and 100 due tasks per tenant per pass. Production values, alerting, and multi-instance ownership remain open for topology review.
4. Do not automatically replay `in_progress` tasks after a process failure. A provider may have accepted or completed an image request. Their durable `in_progress` status remains available for operator inspection; the authorized recovery action and stale threshold remain open and are not implemented here.
5. Test a lost publish, no subscriber at publish time, process restart, duplicate wake-ups, and tenant isolation with fake Redis/provider where possible. Use an isolated database for the repository boundary and migration checks.

## Open production choices

- Production scan interval, batch limit, alerting threshold, and process ownership under expected pilot load. Local defaults above are not production approval.
- When an `in_progress` task is considered stale; who may authorize retry or mark it terminal.
- Maximum attempts and backoff for provider failures, including how ambiguous acceptance is recorded and surfaced.
- Pilot runtime ownership of the scanner/worker, scaling strategy, and restart monitoring. These depend on KAN-62/KAN-15 and cannot be inferred from repository code.
