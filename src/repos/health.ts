/**
 * Tenant-agnostic database reachability check for the readiness probe.
 *
 * It reads no table and binds no tenant, user, or admin GUC, so it can run
 * for an unauthenticated caller without touching RLS-protected data. See
 * `src/db/probe-transaction.ts`.
 */
import { withProbeTransaction } from '../db/probe-transaction';

export function healthRepo() {
  return {
    /** Resolves when `app_user` can run a trivial query within `timeoutMs`; rejects otherwise. */
    async pingDatabase(timeoutMs: number): Promise<void> {
      await withProbeTransaction(timeoutMs, async (tx) => {
        const result = await tx.query<{ ok: number }>('SELECT 1 AS ok');
        if (result.rows[0]?.ok !== 1) throw new Error('Unexpected database probe result');
      });
    },
  };
}

export type HealthRepo = ReturnType<typeof healthRepo>;
