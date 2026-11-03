[← Features](README.md)

# Operations: health, migrations, CI, evals

## What it does

Keeps the pilot deployable and observable: two public probes tell Railway whether a new version
may take traffic, migrations apply themselves safely on every deploy, CI reports lint, types,
tests, build, migrations and tenant isolation on every change to `developer`, and LLM evals
measure the Extractor and Responder on demand (they cost tokens).

## How it works

1. **Health probes.** `app/api/health/route.ts` (liveness, touches nothing) and
   `app/api/health/ready/route.ts` (readiness) are excluded from auth by exact path in
   `proxy.ts`. Readiness runs `src/services/health/readiness.ts:checkReadiness`: PostgreSQL as
   `app_user` through `src/repos/health.ts:healthRepo` over
   `src/db/probe-transaction.ts:withProbeTransaction` (read-only, local timeout, no tenant
   context), and Redis only when `REDIS_URL` is set; 2 s each, in parallel. The body is
   `ok | fail | skipped` per dependency (200/503); details go only to the server log.
2. **Migrations.** `migrations/` (node-pg-migrate) is the schema's source of truth. On deploy,
   Railway's pre-deploy command `npm run migrate:deploy` runs `scripts/migrate-deploy.mjs`
   (logic in `scripts/migrate-deploy-lib.mjs`): it reads only `MIGRATION_DATABASE_URL`, refuses
   `app_user` or the runtime URL, applies pending migrations in one transaction under the same
   advisory lock as the CLI, retries a busy lock, and logs without secrets. A failure aborts the
   deploy and the previous version keeps serving.
3. **Add-only rule.** A running version must work with the new schema, so a migration's `up`
   may only add. Destructive statements need a later deploy and a `// destructive-ok: <reason>`
   marker; `scripts/migration-add-only.mjs` holds the scan.
4. **Local services.** `compose.yaml` runs PostgreSQL 16 and Redis 7 on loopback
   (`npm run services:up` / `services:down`). `scripts/db-smoke.mjs` and `scripts/repo-smoke.mjs`
   are manual sanity checks.
5. **CI.** `.github/workflows/ci.yml` runs on pull requests into and pushes to `developer`, with
   five jobs: Lint, TypeScript, Unit tests (excluding `*.integration.test.ts` and `evals/`),
   Database migrations (fresh PostgreSQL 16, `node-pg-migrate up`,
   `scripts/ci-db-check.mjs`, then the two-tenant suite
   `src/core/__tests__/cross-tenant-isolation.integration.test.ts`), and Production build. It
   uses no paid keys and never runs evals.
6. **Evals.** `evals/extractor.eval.ts` and `evals/responder.eval.ts` (config
   `vitest.eval.config.ts`, datasets in `evals/datasets/`, scorers in `evals/evaluators/`) call
   the real models through the production adapters and report to LangSmith. Scripts:
   `npm run eval`, `eval:extractor`, `eval:responder`. `EVAL_MODEL_PROFILE=cheap|free`
   (`src/services/llm/eval-model-profile.ts`) lowers the cost. The planner is not "evaluated":
   it is deterministic and covered by exact unit tests.
7. **Recovery.** Postgres `agent_tasks` is the source of truth; the periodic scan republishes
   due `pending` tasks; `in_progress` tasks are never replayed automatically
   ([02-agents-and-transport.md](02-agents-and-transport.md)).

## Key rules / invariants

- **Probes never leak details and need no session.** Enforced by
  `app/api/health/__tests__/route.test.ts` and `app/api/health/__tests__/proxy-matcher.test.ts`
  (only the two exact paths are public); `src/repos/__tests__/health.test.ts` and
  `src/services/__tests__/redis-probe.test.ts` cover the checks.
- **Deploy migrations never run as `app_user` and never print the URL.** Enforced by
  `scripts/__tests__/migrate-deploy.test.ts` and `scripts/__tests__/deploy-config.test.ts`
  (also pins `HOSTNAME=0.0.0.0` in `npm start`).
- **Migrations are add-only.** A rollback redeploys old code on the new schema, which is safe
  only if nothing was removed. Enforced by `scripts/__tests__/migrations-add-only.test.ts`
  (migrations newer than `1792800002400_approval-owner-only`; `down` exempt).
- **CI never touches a real database or a paid provider.** Integration tests run only against
  CI's throwaway database; locally, `npm run test:integration` hits the database in `.env.local`
  and needs the owner's OK.
- **No real eval runs without the owner's explicit approval, for each run.** Evals cost tokens
  and their scores are only comparable within the same model profile.
  `evals/_support/__tests__/setup.test.ts` and `evals/evaluators/__tests__/` test the harness
  and scorers without calling a model.

## Decisions

- 2026-10-25 — KAN-83 (owner): migrations apply automatically on every deploy through the
  pre-deploy command; add-only rule. Runbook: [`docs/operations.md`](../operations.md) §7.
- 2026-11-02 — KAN-61 (owner): CI is **report-only**. The private repository is on GitHub's
  Free plan, which cannot enforce required checks, so the owner does not merge to `main` while a
  job is red. [`pipeline/kan-61-ci-policy.md`](../../pipeline/kan-61-ci-policy.md)
- 2026-11-02 — KAN-68: the deterministic regulatory golden set will block on PR, nightly and
  release once KAN-59 adds it; CI green is not legal approval.
  [`pipeline/decisions/KAN-68-regulatory-gate-policy.md`](../../pipeline/decisions/KAN-68-regulatory-gate-policy.md)
- KAN-15 / KAN-62: Railway project `Tendrel_AI / mype-crea`, one Next.js instance per environment
  with the embedded worker. [`pipeline/kan-62-topology.md`](../../pipeline/kan-62-topology.md)
- 2026-10-04 — LangSmith cloud for evals and tracing, dev only; datasets synthetic or anonymized.

## Limits & known gaps

- Railway setup is incomplete: `MIGRATION_DATABASE_URL`, pre-deploy timeout, healthcheck path,
  `BUCKET_*` and scheduled backups are not yet set on every environment (KAN-83, operations
  guide §9). Production has no app deployment yet.
- Readiness does not prove sign-in, LLM, image generation or the worker, nor that migrations ran.
- The deploy step takes no backup; backup targets, RPO/RTO and a restore exercise are pending
  (KAN-53 runbook in progress; KAN-67 proposed,
  [`pipeline/decisions/KAN-67-rpo-rto-backup-scope.md`](../../pipeline/decisions/KAN-67-rpo-rto-backup-scope.md)).
- The regulatory golden-set job (KAN-59) is not in CI yet.
- Multi-replica worker behavior is not reviewed.

## See also

- [`docs/operations.md`](../operations.md) — the full runbook (setup, env vars, deploy, recovery)
- [`pipeline/kan-63-recovery-plan.md`](../../pipeline/kan-63-recovery-plan.md) — task recovery plan
- [05-auth-tenancy-isolation.md](05-auth-tenancy-isolation.md) — what the isolation suite proves
