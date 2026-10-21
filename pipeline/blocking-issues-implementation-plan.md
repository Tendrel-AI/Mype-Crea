# Blocking issues: implementation and validation plan

Goal: implement KAN-61/14/17, KAN-62/15, and KAN-57/63/18 in dependency order; delegate suitable coding, verify each slice, and publish an ordered review PR with hosted CI evidence.

| Order | Dependency path | Implementation status | Remaining acceptance evidence |
|---|---|---|---|
| 1 | KAN-61 → KAN-14 → KAN-17 | CI policy, migration/role gate, and tenant isolation suite committed (`1ef9785`, `82ad00e`, `6d3e16e`). Local PostgreSQL 16 checks passed. | Hosted CI run and branch protection/owner policy review. |
| 2 | KAN-62 → KAN-15 | Local topology, environment template, and runbook committed (`0fd47de`). Owner says an existing Railway app, Postgres, and Redis are available. | Inspect that Railway environment, reconcile thesis constraints, and verify deployment, health, backups, security, and rollback. |
| 3 | KAN-57 → KAN-63 → KAN-18 | Serialized conversation writes, provisional recovery policy, and periodic pending-task recovery committed (`51c47c9`, `ba08bbe`, `026fe14`). Focused unit and PostgreSQL 16 integration tests passed. | Hosted/deployed evidence; owner decisions on retry and ambiguous in-progress work. |

The implementation was delegated across CI/isolation, pilot topology, state concurrency, and durable recovery agents. The primary agent reviewed and integrated their changes. The seven commits above are in that order on local `developer` and have not been pushed. Unrelated KAN-70 work in the worktree is excluded from this plan and its commits.

Next: prepare a review branch/PR containing only the ordered commits; run hosted CI; inspect the existing Railway pilot without changing live data; then record accurate evidence and open decisions in Jira. Do not close a ticket before its acceptance evidence exists.
