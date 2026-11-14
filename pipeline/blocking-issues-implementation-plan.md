# Blocking issues: implementation and validation plan

Goal: implement KAN-61/14/17, KAN-62/15, and KAN-57/63/18 in dependency order; delegate suitable coding, verify each slice, and publish an ordered review PR with hosted CI evidence.

| Order | Dependency path | Implementation status | Remaining acceptance evidence |
|---|---|---|---|
| 1 | KAN-61 → KAN-14 → KAN-17 | CI policy, migration/role gate, and tenant isolation suite committed (`1ef9785`, `82ad00e`, `6d3e16e`). Local PostgreSQL 16 checks and PR #4 hosted CI passed. | Branch protection/owner policy review. |
| 2 | KAN-62 → KAN-15 | Local topology, environment template, and runbook committed (`0fd47de`). Owner approved the Railway topology. Development app, Postgres, and newly provisioned Redis are running; `REDIS_URL` is staged without app redeploy. Production has Postgres but no active app or Redis. | Resolve missing runtime secret references, then verify development and production deployment, health, backups, security, and rollback. |
| 3 | KAN-57 → KAN-63 → KAN-18 | Serialized conversation writes, provisional recovery policy, and periodic pending-task recovery committed (`51c47c9`, `ba08bbe`, `026fe14`). Focused unit and PostgreSQL 16 integration tests passed. | Hosted/deployed evidence; owner decisions on retry and ambiguous in-progress work. |

The implementation was delegated across CI/isolation, pilot topology, state concurrency, and durable recovery agents. The primary agent reviewed and integrated their changes. The seven implementation commits above are in that order on `developer` and published in PR #4. That PR also contains ten commits that were already ahead of `origin/developer`; unrelated uncommitted KAN-70 work is excluded.

PR #4 is open; its hosted CI passed. Evidence is recorded on KAN-14, KAN-15,
and KAN-18. Next: resolve the empty development `APP_DATABASE_URL` reference,
then verify deployment and recovery behavior. Do not close a ticket before its
acceptance evidence exists.
