[← Features](README.md)

# Backup and restore

## What it does

Defines how much data the pilot may lose and how fast it must come back. It also provides a scripted rehearsal that proves a dump restores into a working, tenant-isolated database.

## How it works

1. **Targets.**
   - RPO ≤ 24 h (≈0 for loss caused by a migration, thanks to pre-migration dumps).
   - RTO ≤ 2 h, weekdays 09:00–18:00 America/Lima.
   - The owner authorizes and executes every restore.
   Recorded in [`pipeline/decisions/KAN-67-rpo-rto-backup-scope.md`](../../pipeline/decisions/KAN-67-rpo-rto-backup-scope.md).
2. **Runbook.** [`pipeline/kan-53-restore-runbook.md`](../../pipeline/kan-53-restore-runbook.md) covers when to restore, the steps, credential rotation and the restore log.
3. **Rehearsal.** `scripts/restore-rehearsal.sh` runs the whole cycle on throwaway local instances:
   - starts a throwaway local PostgreSQL and applies every migration;
   - seeds two synthetic tenants (`scripts/restore-rehearsal-seed.sql`);
   - runs `pg_dump`, then restores into a second fresh instance;
   - times each step and runs the coherence checks, including the cross-tenant suite.
   `DUMP_FILE=<file>` restores an existing dump instead.
4. **Evidence.** [`pipeline/kan-53-rehearsal-2026-11-02.md`](../../pipeline/kan-53-rehearsal-2026-11-02.md) records the inventory, the measured times (RTO 0.94 s seeded, 5.42 s for a 299 MB database), the checks, and gaps G1–G9.

## Key rules / invariants

- **The rehearsal never touches a real database.** It refuses non-local hosts in any database URL, `PGHOST` or `PGHOSTADDR`, then unsets every `PG*` variable. Enforced by `scripts/__tests__/restore-rehearsal.test.ts`.

## Limits

- **Production has no backups yet** (G1, KAN-83). Until Railway scheduled backups are on, the real RPO is unbounded.
- Assets in the bucket are covered only after KAN-52.
- Retention and post-pilot deletion need legal input.
- With a single operator, the RTO depends on the owner being available (G9).

## See also

[11-operations.md](11-operations.md) · [`docs/operations.md`](../operations.md)
