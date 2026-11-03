# KAN-53 — Backup inventory and restore rehearsal (2026-11-02)

Targets (KAN-67, approved 2026-11-02): RPO ≤ 24 h (≈0 for migration-induced loss), RTO ≤ 2 h,
weekdays 09:00–18:00 America/Lima. Procedure: `pipeline/kan-53-restore-runbook.md`.
Script: `scripts/restore-rehearsal.sh` (+ `scripts/restore-rehearsal-seed.sql`).

**Result:** the restore path works and is verified end to end on synthetic data: 0 failed checks,
RTO 0.94 s (seeded) and 5.42 s (299 MB database). The targets are **not met in production yet**,
because no backup exists there to restore from (gaps G1–G3).

## 1. Inventory (read-only)

Sources: the repository (`docs/operations.md` §7, §9 and §10, `pipeline/kan-62-topology.md`),
Railway docs, and the Railway CLI on project `Tendrel_AI / mype-crea`
(`200e2d05-…`), using only read commands (`volume list`, `bucket list`/`info`, `status --json`).
The Railway MCP tools returned `Unauthorized` for this project, so the CLI was used. Nothing was
changed in Railway. The scratch directory was linked locally to read the project and then
unlinked.

| Mechanism | Exists today? | Evidence |
|---|---|---|
| Railway PostgreSQL, production | Yes. Service `Postgres`, region `us-east4`, volume `postgres-volume` 1,107 MB used of 50 GB | `railway volume list`, `status --json` |
| Railway PostgreSQL, development | Yes. Same layout, 892 MB used. Redis volume 791 MB (ephemeral by design) | same |
| Railway scheduled volume backups (daily kept 6 d, weekly kept 27 d, monthly kept 89 d) | **Not configured** per the owner. The CLI and status JSON do not expose the Backups tab, so this could not be checked independently | owner statement; `docs/operations.md` §7/§9 ("must be enabled… owner action"); KAN-83 open |
| Railway point-in-time recovery (pgBackRest WAL to a bucket, about 4 weeks, restores into a **new** service) | **Not enabled.** No `Postgres-PITR` bucket in either environment | `bucket list` |
| Independent `pg_dump` job and storage | **No** | no job, script, or bucket for it in the repo or the project |
| Dump before each production migration | **No.** `migrate:deploy` takes no backup | `docs/operations.md` §7 |
| Asset bucket `mype-crea-assets` | Development only: region `sjc` (US West), 14 objects, 2.7 MB. **Production has no bucket** | `railway bucket list/info` |
| Asset object versioning or copy | **No.** Railway bucket docs describe no versioning. The app never deletes objects (keep-everything) | Railway docs; `docs/operations.md` §9 |
| App wiring to the bucket | In code (KAN-52), but `BUCKET_*` is not set on any Railway environment | `docs/operations.md` §9 |
| Deployments | Development app `mype-dev` is `NEEDS_APPROVAL`. Production has only PostgreSQL | `status --json` |

Facts from Railway's docs that shape the runbook:

- A volume backup restores only **into the same project and environment**. It mounts a new
  volume on the same service, as a staged change you then deploy. So it is a production
  operation, not an isolated restore.
- "Wiping a volume deletes all backups." The backups share the volume's fate.
- A PITR restore creates a separate `<source>-restored-…` service and never touches the source.
  This is the only Railway-native isolated restore.

## 2. Rehearsal setup

- Local and isolated: two throwaway PostgreSQL 18.4 clusters (Homebrew `initdb`/`pg_ctl`) on
  `127.0.0.1:55432` (source) and `:55433` (target), TCP loopback only, scram auth with a random
  password, in a temp directory deleted afterwards. No `.env.local` and no Railway database was
  read, and no production data was used. The script refuses a non-local `DATABASE_URL`,
  `APP_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `PGHOST` or `PGHOSTADDR`, then unsets every
  `PG*` variable. This is unit-tested by `scripts/__tests__/restore-rehearsal.test.ts`. The final
  run below was made with `PGHOSTADDR=127.0.0.1 PGSSLMODE=require PGUSER=nobody` set, to show that
  stray libpq variables are ignored.
- Source: all 25 migrations as the owner role (`postgres`), so `app_user` is created exactly as
  in `…068790_app-role-and-grants`. Seed (`restore-rehearsal-seed.sql`): two institutional
  tenants, each with an admin and a member, 3 conversations with `agent_states`, 18 messages, 3
  root logo tasks plus 3 iterations, 6 deliverables with `storage_key`, 3 approvals (the
  iteration selected), 1 stale mark, 2 `terminos-v1` acceptances, 6 `llm_calls`, and 1 AI config
  audit event. The migration-seeded pilot tenant is also present.
- Backup: `pg_dump -Fc`. Then one message was written to the source **after** the dump, to
  stand for work done between the backup and the incident.
- Restore: fresh cluster, `CREATE ROLE app_user LOGIN NOBYPASSRLS` with a **new random
  password** (pg_dump does not carry roles), `CREATE DATABASE`, then
  `pg_restore --exit-on-error --single-transaction`.

## 3. Measured times (run 2026-11-03T03:39:08Z UTC = 2026-11-02 22:39 Lima)

| Step | Seconds |
|---|---|
| source: initdb + start | 0.48 |
| source: apply 25 migrations | 0.32 |
| source: seed | 0.03 |
| backup: `pg_dump -Fc` (197,805 bytes) | 0.06 |
| *incident declared, RTO clock starts* | |
| restore: initdb + start fresh instance | 0.48 |
| restore: create `app_user` + database | 0.06 |
| restore: `pg_restore --single-transaction` | 0.10 |
| restore: verification checks | 0.26 |
| **RTO (incident → restored and verified)** | **0.94** |
| extended: KAN-17 isolation suite on the restored DB | 0.68 |

**Data-loss window: 0.10 s** (dump start → incident). The post-dump message is absent from the
restore, as expected. In operation, the window equals the age of the newest usable backup. With
a daily schedule that is at most 24 h plus the dump time, which meets the RPO. Today there is
**no** backup, so the production loss window is unbounded (G1).

Scale probe (same day, dump mode). Manual steps, not part of the script: a `KEEP=1` seeded run,
then on its source
`INSERT INTO messages … SELECT … FROM conversations c, generate_series(1, 70000)` (content
`repeat(md5(random()::text), 12)`) and
`INSERT INTO llm_calls … FROM conversations c, generate_series(1, 30000)`. The source grew to
**299 MB** (420,037 messages, 180,012 `llm_calls`). `pg_dump -Fc` took 1.57 s and produced 26 MB.
Then `DUMP_FILE=<that dump> scripts/restore-rehearsal.sh` gave pg_restore 2.35 s, checks 2.49 s,
and **RTO 5.42 s**, with 0 failed checks. Production's
volume shows 1.1 GB used, which includes WAL and system files. The actual database size and the
download time from Railway were not measured (G8). Even 10× the probe stays far inside 2 h. The
RTO budget is dominated by human steps: getting the dump, rotating credentials, and redeploying.

## 4. Coherence checks (all PASS)

| Check | Result |
|---|---|
| Source at dump vs restore, 597 fingerprint lines: per-table row count **and content hash** (ordered `md5` of every row) for all 28 public tables; per-tenant row counts for every tenant-keyed table; sequence values (incl. `deliverable_event_seq`); every constraint with its validated flag; triggers and enabled state; RLS enabled/forced per table; policies; `app_user` grants; migration head | PASS: identical |
| Per-tenant counts (both tenants): users 2, conversations 3, messages 18, agent_tasks 6, deliverables 6, deliverable_approvals 3, deliverable_stale_marks 1, terms_acceptances 2, llm_calls 6, ai_config_audit_events 1. Pilot tenant: users 1 | PASS: identical to the source |
| FK integrity: `pg_restore --single-transaction --exit-on-error` re-adds and validates every FK, and an explicit orphan query (deliverable→task in the same conversation, task→conversation, iteration→root in the same conversation, approval→deliverable in the same conversation, message→conversation) | PASS: 0 orphans. The one `NOT VALID` check (`llm_calls_provenance_required`) is carried over still `NOT VALID`, as in the source |
| Migration head = latest file in `migrations/` (`1792800005000_terms-acceptances`) | PASS |
| Post-dump write absent | PASS |
| Asset references: every `storage_key` listed (12) and under its own `tenants/<tenant_id>/` prefix; 0 provider-URL-only deliverables | PASS. Objects not checked (G5) |
| `app_user` can log in, no `BYPASSRLS`, not superuser | PASS |
| As `app_user`: with no tenant context, every readable tenant-keyed table returns 0 rows. With each tenant's admin context (`app.tenant_id`, `app.user_id`, `app.is_tenant_admin`), 0 foreign rows across 54 (tenant, table) pairs, and the visible own rows equal the owner's count for that tenant (48 per seeded tenant, 1 for the pilot tenant). The check fails if no pair was checked | PASS. A reviewer mutation test confirmed it FAILS on a leaking policy and on RLS disabled |
| KAN-17 cross-tenant isolation suite (`cross-tenant-isolation.integration.test.ts`, through `repos()` as `app_user`) against the restored DB | PASS: 4/4 |

## 5. Gaps

| # | Gap | Belongs to |
|---|---|---|
| G1 | Railway scheduled backups are not enabled in development or production. Until they are, production has no backup and no bounded RPO. Enabling them is an owner action in the Backups tab | KAN-83 |
| G2 | No rehearsal yet against a real Railway backup or dump: restore time from Railway, the real PostgreSQL major version, real roles and owners, and real data size are unmeasured. Re-run `DUMP_FILE=… scripts/restore-rehearsal.sh` on a dump once G1 is closed. Where it may run is open: dumps must stay in Railway's region, and the owner has not said whether a temporary copy outside Railway is allowed for restore work (runbook rule 2) | KAN-53 (after KAN-83); owner decision |
| G3 | No independent scheduled `pg_dump` job and no encrypted storage for it (KAN-67 Option B). The location must stay in Railway's region, and which region (`us-east4` PostgreSQL vs `sjc` bucket) needs owner confirmation | KAN-67 follow-up (no ticket yet) |
| G4 | No automatic dump before production migrations: `migrate:deploy` takes none, so the "≈0 for migration-induced loss" target relies on the manual step in the runbook | KAN-15 / KAN-83 |
| G5 | **Asset restore not rehearsed.** S3 objects cannot be restored locally. Production has no bucket, `BUCKET_*` is unset everywhere, and Railway buckets have no documented versioning, so a deleted or overwritten object cannot be recovered. Only the key list was verified | KAN-52 / KAN-83 |
| G6 | Railway volume backups restore in place (same project and environment), not into an isolated environment. An isolated restore needs the logical-dump path (this runbook) or PITR (not enabled) | KAN-53 / KAN-83 (decide whether to enable PITR) |
| G7 | Retention and post-pilot deletion of backups and dumps are undecided. Railway's built-in retention (6 d / 27 d / 89 d) applies once enabled | KAN-67 (open item; institutional and legal input, Ley 29733) |
| G8 | Production database size and PostgreSQL version not read (would need a database connection, which was out of scope). The client `pg_dump` must be ≥ the server's major version. The local restore target was 18.4; CI uses 16 | KAN-83 inventory |
| G9 | Single operator: the owner both authorizes and executes. If he is unavailable during operating hours, the RTO cannot be met. Recorded as a risk of the approved decision. Whether it is accepted is for the owner to confirm | KAN-67 |

Not gaps: Redis is excluded by design (KAN-63 rescans `pending` tasks from PostgreSQL). WorkOS
is the external identity system of record. Restored `users.workos_user_id` values stay valid as
long as the WorkOS users exist.

## 6. Review

An independent review pass (reviewer agent, 2026-11-02) re-ran the rehearsal (0 failed checks)
and mutation-tested the RLS check. Its blocking findings were fixed before commit:

- `PGHOSTADDR` could redirect libpq. It is now refused when non-local, and every `PG*` variable
  is unset.
- The runbook allowed dump copies outside Railway's region. That is now an open owner decision.
- An empty tenant list passed the RLS check. It now fails, and own-row counts are asserted.

Also applied: scram auth on the throwaway clusters, the log and key list kept when a step fails,
per-row hashing in the fingerprint, and runbook fixes (`DATABASE_PUBLIC_URL` with
`sslmode=require`, `pg_restore -f /dev/null` as the integrity check, verify before reopening, and
the volume-backup caveat). The owner's review of the runbook is still pending.

## 7. Re-running

```bash
scripts/restore-rehearsal.sh                                # seeded rehearsal, as above
DUMP_FILE=/secure/path/db.dump scripts/restore-rehearsal.sh # a real dump (runbook §3)
# LOG_FILE=<path> copies the log out; KEEP=1 leaves both servers running for inspection.
```
