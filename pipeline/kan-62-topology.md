# KAN-62 / KAN-15: pilot topology and operating path

Status: repository and local-development record. The owner selected the
`Tendrel_AI / mype-crea` Railway project. Its service inventory and active
deployments were inspected read-only on 2026-10-20. No cloud resources were
changed, and no deployment or health acceptance is claimed. The pilot
configuration still needs reconciliation with the thesis requirements.

## Inventory: verified facts

| Area | Verified in repository | Not verified here |
|---|---|---|
| App | Next.js 16; `next.config.ts` builds `output: 'standalone'`; `npm start` runs the standalone server. Railway development `mype-dev` has a RUNNING instance; production has no active app deployment. | Runtime config, public URL, and health. |
| Database | PostgreSQL; migrations through `node-pg-migrate`; app uses `APP_DATABASE_URL`; migration/admin tooling uses `DATABASE_URL`; runtime role must be `app_user` without `BYPASSRLS`. Railway Postgres has RUNNING instances in development and production. | Backups, encryption settings, network allowlists, audit logs, live schema/version. |
| Queue and notifications | Redis Pub/Sub is optional for chat; with `REDIS_URL`, the durable logo worker boots within the Next.js process. | No Redis service is listed in the approved Railway project; its location and configuration remain open. |
| Assets | Logo output is persisted through current deliverable/repository code when the durable path is active. Railway lists a `mype-crea-assets` bucket. | App integration, private object storage policy, and signed asset URLs; these belong to KAN-52. |
| Local services | `compose.yaml` now describes loopback-only PostgreSQL 16 and Redis 7 with named volumes and health checks. | Whether previously documented local containers/volumes or `.env.local` values are present or healthy. Docker API access was denied in this inspection. |
| GitHub | PR #4's hosted CI run passed lint, typecheck, unit tests, build, and isolated PostgreSQL migration checks. | Branch protection/required checks, deployment environments, and secret settings. |

The code does not currently expose a public app health/readiness endpoint. The
local Compose health checks prove only that PostgreSQL and Redis answer their
own probes; `scripts/db-smoke.mjs` checks application DB connectivity, role, and
RLS posture. Neither proves end-to-end login, LLM, image, or pilot health.

## Proposed reversible local default

```text
Browser ── localhost:3000 ── Next.js dev process
                                  ├── PostgreSQL 16 :5434 (app_user + RLS)
                                  └── Redis 7 :6379 ── logo worker in app process
```

`compose.yaml` binds both service ports to `127.0.0.1`; data lives in named
volumes. Start with `npm run services:up`, inspect with `npm run services:status`,
and stop with `npm run services:down`. The down command preserves data. Compose
defaults and credentials are for local development only. Copy `.env.example` to
`.env.local`, keep credentials out of source control, and use a distinct app
database role for runtime access.

The first role migration currently creates `app_user` with a literal bootstrap
password. Treat that value as local-only; before any shared/hosted database,
rotate it through an authorized database administration path and configure
`APP_DATABASE_URL` with the rotated value. Do not use the owner connection as the
application runtime connection.

## Safe local migration and recovery sequence

1. Confirm the target from `.env.local` before running migration commands. They
   load `DATABASE_URL` from that file. Never point local commands at a pilot or
   production database by accident.
2. Start services and wait for healthy status: `npm run services:up`, then
   `npm run services:status`.
3. For an existing database, take a backup before schema changes. For local
   recovery, keep a dump outside the repo and confirm it is readable before
   proceeding. This document does not define pilot RPO/RTO; KAN-53 owns that
   decision and restore exercise.
4. Apply forward migrations with `npm run migrate:up`. On any error, stop the
   rollout, keep the error output, inspect the migration ledger and current
   schema, then repair or restore only against a disposable/local target. Do not
   blindly run `migrate:down` against data-bearing environments.
5. Run `node --env-file=.env.local scripts/db-smoke.mjs` to confirm the runtime
   connection, role, and RLS visibility. This is a local smoke check, not a
   production health probe.
6. Start/restart the app after environment changes so service clients are
   recreated. A source rollback does not reverse database migrations. Prefer a
   reviewed forward fix; restore from backup only under the owner-approved
   recovery procedure.
7. To recover local service processes, `npm run services:down` then
   `npm run services:up`. This preserves named volumes. Do not remove volumes
   as a routine restart or recovery step.

The commands above are documented, not executed in this task. No `.env.local`
database integration tests were run.

## Deployment and security decisions still open

The following must be agreed before provisioning or calling KAN-15 complete:

- Verify the owner-reported Railway app, PostgreSQL, and Redis, their region,
  and private asset storage; reconcile the cited thesis anchors P0657, P0669,
  P0718, and P0767–P0772.
- Persistent app runtime and worker scaling. Current design runs the worker in
  the Next.js process; multiple replicas may create multiple subscribers, so
  production concurrency/restart semantics need explicit review.
- Separation and data policy for local, PR preview, and pilot environments,
  including whether previews may use any shared data or credentials.
- TLS in transit, encryption at rest, backup encryption/retention, network
  boundaries, least-privilege access, audit-log access/retention, and secret
  ownership/rotation. These properties are not established by repository config.
- Migration ownership/locking, deploy trigger and source branch, failure gate,
  smoke checks, rollback/forward-fix procedure, and who authorizes recovery.
- Public liveness/readiness probe behavior and allowed unauthenticated surface.
  No health route is present today; do not expose database details in a probe.
- Asset storage and signed-URL design (KAN-52), backup/restore targets and
  RPO/RTO (KAN-53), CI coordination (KAN-14), and durable dispatch/recovery
  semantics (KAN-18).

The current README and stack docs previously mentioned Railway and AI Studio /
Cloud Run as context. The owner has now identified the Railway project; its
service inventory is verified, while live settings remain unverified. See
[KAN-62](https://matyaslopz.atlassian.net/browse/KAN-62) and
[KAN-15](https://matyaslopz.atlassian.net/browse/KAN-15).
