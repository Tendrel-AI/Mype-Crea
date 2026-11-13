/**
 * Platform-side limit defaults (D38, F24): the only writer of `platform_limit_defaults`, through
 * `app.set_platform_limit_default`. Existing tenant profiles hold copied values and are NOT touched.
 * Range and key shape are validated by the caller (catalog validators) and re-checked in the DB.
 */
import { withGlobalTransaction } from '../db/global-transaction';
import type { LimitValues } from '../core/limits/catalog';
import { loggerFor } from '../services/logger';
import { assertActivePlatformActor, insertGlobalAuditEvent } from './global-audit';

const log = loggerFor('repos.global-limits');

export function globalLimitsRepo() {
  return {
    /** Stored defaults (the catalog completes missing keys). */
    async list(): Promise<LimitValues> {
      return withGlobalTransaction(async (tx) => {
        const res = await tx.query<{ limit_key: string; value: number }>('SELECT limit_key, value FROM platform_limit_defaults');
        return Object.fromEntries(res.rows.map((r) => [r.limit_key, r.value]));
      });
    },

    async set(input: { limitKey: string; value: number; reason: string; actorWorkosUserId: string }): Promise<void> {
      await withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, input.actorWorkosUserId);
        const res = await tx.query<{ before: number | null }>('SELECT app.set_platform_limit_default($1, $2) AS before', [input.limitKey, input.value]);
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: input.actorWorkosUserId, action: 'limits.default.set', scopeType: 'limit_default',
          scopeId: input.limitKey, outcome: 'success', reason: input.reason,
          metadata: { before: res.rows[0]?.before ?? null, after: input.value },
        });
        log.info({ limitKey: input.limitKey, value: input.value }, 'limits.default.set');
      });
    },
  };
}

export type GlobalLimitsRepo = ReturnType<typeof globalLimitsRepo>;
