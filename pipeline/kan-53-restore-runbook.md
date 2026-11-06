# KAN-53 — Restore runbook (pilot)

Targets and roles come from KAN-67 (approved 2026-11-02,
`pipeline/decisions/KAN-67-rpo-rto-backup-scope.md`):

- **RPO ≤ 24 h**, and ≈0 for migration-induced loss (dump before every production migration).
- **RTO ≤ 2 h**, within pilot operating hours: **weekdays 09:00–18:00 America/Lima**.
- **The owner (Matias) authorizes and executes** every restore. A production restore needs their
  explicit authorization each time. Write it in the restore log (§6) before step 1.
- Dumps stay in Railway's region. No copies elsewhere. Retention is still open (Ley 29733), so
  delete nothing on a schedule.

In scope: the whole PostgreSQL database (tenant data, AI config and releases, turn traces,
`llm_calls`, platform and audit tables) and the asset bucket objects. Out of scope: Redis
(rebuilt by the KAN-63 rescan), WorkOS (external system of record), and fal.ai URLs.

Latest rehearsal and inventory: `pipeline/kan-53-rehearsal-2026-11-02.md`.

## 0. Rules

1. **Never restore over production to "try" something.** Restore into an isolated database
   first (§3), verify it, and only then decide whether to cut over (§4).
2. A dump of production is production data. Keep it encrypted at rest (KAN-67 Option B), and
   **only in Railway's region**: the owner ruled out copies elsewhere. Never put it in the repo
   or a chat. **TBD with owner:** whether a temporary copy outside Railway (for example on the
   owner's machine, for §3) is allowed during restore work. Until he decides, run §2 and §3 from
   inside Railway's region (a temporary service or shell in a non-production environment of the
   same project). Retention is open, so this runbook sets no deletion rule.
3. Railway changes (restoring a backup, variables, deploys) are made only during a §4 cutover
   that the owner authorized.
4. Log every timestamp in §6. The RTO clock starts when the incident is declared.

## 1. Backup sources, in order of preference

| Source | RPO it gives | Isolated? | Status 2026-11-02 |
|---|---|---|---|
| Pre-migration dump (§2) | ≈0 for a bad migration | yes (logical dump) | manual step; not automated (G4) |
| Independent scheduled `pg_dump` (KAN-67 B) | ≤ 24 h | yes | **not built** (G3) |
| Railway scheduled volume backup (Backups tab) | ≤ 24 h with Daily | **no**: restores in place, same project and environment | **not enabled** (G1, KAN-83) |
| Railway PITR (if enabled later) | minutes | yes: creates a new `…-restored-…` service | not enabled |

## 2. Taking a logical dump (pre-migration or on demand)

Run with the PostgreSQL owner connection of the target environment. Inside Railway's private
network that is the Postgres service's `DATABASE_URL` (`*.railway.internal`). From outside, it is
`DATABASE_PUBLIC_URL` (TCP proxy) with `sslmode=require`. Do not use `app_user`: pg_dump runs
with `row_security=off`, so a role subject to RLS gets an error instead of a dump.

```bash
pg_dump --version   # must be >= the server's major version (SELECT version();)
pg_dump -Fc --no-password -d "$OWNER_URL" -f "mype-<env>-$(date -u +%Y%m%dT%H%MZ).dump"
pg_restore -f /dev/null mype-<env>-<ts>.dump && echo readable   # reads every data block
```

Record the dump's UTC time and size. Before a production migration, take this dump right
before the deploy, so the migration's loss window is ≈0.

## 3. Isolated restore and verification (always first)

```bash
DUMP_FILE=/secure/path/mype-<env>-<ts>.dump LOG_FILE=/secure/path/restore.log \
  scripts/restore-rehearsal.sh
```

Where it runs: see rule 2. The script refuses any non-local database URL, `PGHOST` or
`PGHOSTADDR`, and unsets every other `PG*` variable. It starts a throwaway PostgreSQL on
127.0.0.1 (password auth, random password), creates `app_user` with a fresh password (pg_dump does not carry roles), restores
with `pg_restore --exit-on-error --single-transaction`, and checks:

- the migration head equals the latest file in `migrations/` (check out the commit that is
  deployed, or expect a mismatch);
- no orphans along conversation → task → deliverable → approval, and every FK re-validated;
- every deliverable `storage_key` sits under its own tenant prefix, with the full list copied
  to `<LOG_FILE>.storage-keys.txt`;
- `app_user` has no `BYPASSRLS` and sees nothing without a tenant context. In each tenant's admin
  context it sees no foreign rows, and exactly the owner's count of that tenant's rows;
- the KAN-17 cross-tenant isolation suite passes against the restored database.

It prints the RTO for the restore part. If it fails, stop: the dump is not usable. Try the next
older backup, and record the failure.

If the dump names roles other than `postgres` and `app_user` (for example a separate migration
owner), `pg_restore` stops at the first `ALTER … OWNER`. Create those roles first (list them
with `pg_restore -f - <dump> | grep -E 'OWNER TO|GRANT'`), then re-run.

In dump mode there is no source to compare with. The full source-vs-restore fingerprint (row
counts and content hashes per table and per tenant, schema, RLS, grants) runs only in the
seeded rehearsal.

## 4. Production cutover (only with the owner's explicit authorization)

Pick one path. Each keeps the broken database around until the new one is verified.

**A. From a logical dump (preferred, after §3 passed).**

1. Announce maintenance to pilot participants. Stop writes by stopping the app service (scale
   to 0 or remove its deployment). The worker runs inside the same process, so this stops it
   too.
2. Create a new Railway PostgreSQL service in the same environment. In it, create `app_user`
   (`LOGIN NOBYPASSRLS`, new strong password) and any other owner roles from §3.
3. `pg_restore --exit-on-error --single-transaction -d "$NEW_OWNER_URL" <dump>`.
4. Before any traffic, check the new database directly: the `pgmigrations` head, the
   `app_user` posture (`rolbypassrls = false`), and the row counts of the main tables against
   the §3 log.
5. Point the app at the new database: `APP_DATABASE_URL` (app_user, new password),
   `MIGRATION_DATABASE_URL` and `DATABASE_URL` (owner). Redeploy. The pre-deploy
   `migrate:deploy` applies any migrations newer than the dump. Run §5 before announcing that
   the service is back. Keep the old service, unused and not deleted, until the owner closes the
   incident.

**B. From a Railway volume backup (once G1 is closed).** Backups tab → choose the backup by date
→ Restore → review the staged change (a new volume mounted on the same service; the old volume
is kept unmounted) → Deploy. This replaces production data in place, and a volume backup cannot
be exported to run §3 first. Use it when no verified dump of similar age exists, and verify
afterwards (§5) with writes still stopped.

**C. PITR (only if enabled later).** Restore to a timestamp. Railway creates
`<source>-restored-…`, a separate service. Run §3's checks against a dump of it, then cut over
by switching the URLs as in A.5.

## 5. After any restore

- Run `GET /api/health/ready`, sign in, do one chat turn, and confirm a logo task round trip.
- Redis: nothing to restore. On start, the worker republishes due `pending` tasks from
  PostgreSQL. `in_progress` tasks stay visible for the operator (`docs/operations.md` §10).
- Assets: compare `storage-keys.txt` with a listing of the environment's bucket. Keys with no
  object are lost images. Record them, and tell the affected users that the logo must be
  regenerated. No versioning exists yet (G5).
- Data written after the backup is lost. Use the dump time and the incident time to tell
  affected users which window to redo.
- Rotate any credential that touched the dump.

## 6. Restore log (copy for each restore or rehearsal)

```
Date / environment / reason:
Authorized by (owner) at (Lima time):
Backup used (source, UTC time, size):
Incident declared (UTC):            -> RTO clock start
Isolated restore verified (UTC):    script RESULT:
Cutover path (A/B/C) and done (UTC):
Service verified (UTC):             -> RTO = verified - declared
Data-loss window = incident - backup time:
Lost assets (keys):
Follow-ups:
```

## 7. Rehearsal cadence

Re-run the seeded rehearsal (`scripts/restore-rehearsal.sh`) after any migration that adds
tables, roles, triggers, or RLS policies. Once G1 is closed, run §3 on a real backup. That
rehearsal is still owed (G2). The cadence during the pilot is TBD with the owner.
