import { withGlobalTransaction } from '../db/global-transaction';
import { assertActivePlatformActor, insertGlobalAuditEvent } from './global-audit';

export type BootstrapResult = 'granted' | 'already_bootstrapped';
export type SuperadminRecord = {
  workosUserId: string;
  grantedAt: Date;
  revokedAt: Date | null;
};

export function globalIdentityRepo() {
  return {
    async listSuperadmins(): Promise<SuperadminRecord[]> {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{
          workos_user_id: string;
          granted_at: Date;
          revoked_at: Date | null;
        }>(
          `SELECT workos_user_id, granted_at, revoked_at
             FROM platform_superadmins
            ORDER BY revoked_at NULLS FIRST, granted_at, workos_user_id`,
        );
        return result.rows.map((row) => ({
          workosUserId: row.workos_user_id,
          grantedAt: row.granted_at,
          revokedAt: row.revoked_at,
        }));
      });
    },

    async isSuperadmin(workosUserId: string): Promise<boolean> {
      return withGlobalTransaction(async (tx) => {
        const result = await tx.query<{ allowed: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM platform_superadmins
              WHERE workos_user_id = $1 AND revoked_at IS NULL
           ) AS allowed`, [workosUserId],
        );
        return result.rows[0]?.allowed ?? false;
      });
    },

    async bootstrapSuperadmin(workosUserId: string): Promise<BootstrapResult> {
      return withGlobalTransaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [710071]);
        const state = await tx.query<{ completed_at: Date | null }>(
          'SELECT completed_at FROM platform_bootstrap_state WHERE id = true',
        );
        if (state.rows[0]?.completed_at) return 'already_bootstrapped';

        await tx.query(`SELECT set_config('app.platform_bootstrap', 'true', true)`);
        await tx.query(
          `INSERT INTO platform_superadmins (workos_user_id, granted_by_workos_user_id, grant_source)
           VALUES ($1, NULL, 'bootstrap')
           ON CONFLICT (workos_user_id) DO UPDATE
             SET revoked_at = NULL, revoked_by_workos_user_id = NULL, granted_at = now(), grant_source = 'bootstrap'
             WHERE platform_superadmins.revoked_at IS NULL`,
          [workosUserId],
        );
        await tx.query(`SELECT set_config('app.platform_actor_workos_user_id', $1, true)`, [workosUserId]);
        await tx.query(
          `INSERT INTO platform_bootstrap_state (id, completed_at, initial_superadmin_workos_user_id)
           VALUES (true, now(), $1)`, [workosUserId],
        );
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId: workosUserId,
          action: 'superadmin.bootstrap',
          scopeType: 'platform_identity',
          scopeId: workosUserId,
          outcome: 'success',
          reason: 'Configured initial platform administrator',
        });
        return 'granted';
      });
    },

    async grantSuperadmin(actorWorkosUserId: string, targetWorkosUserId: string, reason: string): Promise<void> {
      await withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        await tx.query(
          `INSERT INTO platform_superadmins (workos_user_id, granted_by_workos_user_id, grant_source)
           VALUES ($1, $2, 'authorized')
           ON CONFLICT (workos_user_id) DO UPDATE SET revoked_at = NULL,
             revoked_by_workos_user_id = NULL,
             granted_at = now(), granted_by_workos_user_id = EXCLUDED.granted_by_workos_user_id,
             grant_source = 'authorized'`, [targetWorkosUserId, actorWorkosUserId],
        );
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId, action: 'superadmin.grant', scopeType: 'platform_identity',
          scopeId: targetWorkosUserId, outcome: 'success', reason,
        });
      });
    },

    async revokeSuperadmin(actorWorkosUserId: string, targetWorkosUserId: string, reason: string): Promise<boolean> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const active = await tx.query<{ total: string; target_active: boolean }>(
          `SELECT count(*)::text AS total,
             coalesce(bool_or(workos_user_id = $2 AND revoked_at IS NULL), false) AS target_active
             FROM platform_superadmins WHERE revoked_at IS NULL`,
          [actorWorkosUserId, targetWorkosUserId],
        );
        if (active.rows[0]?.target_active && Number(active.rows[0].total) <= 1) {
          throw new Error('No puedes revocar al único administrador global activo.');
        }
        if (targetWorkosUserId === actorWorkosUserId) {
          await insertGlobalAuditEvent(tx, {
            actorWorkosUserId, action: 'superadmin.revoke', scopeType: 'platform_identity',
            scopeId: targetWorkosUserId, outcome: 'success', reason,
          });
        }
        const changed = await tx.query(
          `UPDATE platform_superadmins SET revoked_at = now(), revoked_by_workos_user_id = $2
            WHERE workos_user_id = $1 AND revoked_at IS NULL`, [targetWorkosUserId, actorWorkosUserId],
        );
        if (targetWorkosUserId !== actorWorkosUserId) {
          await insertGlobalAuditEvent(tx, {
            actorWorkosUserId, action: 'superadmin.revoke', scopeType: 'platform_identity',
            scopeId: targetWorkosUserId, outcome: 'success', reason,
          });
        }
        return (changed.rowCount ?? 0) > 0;
      });
    },
  };
}

export type GlobalIdentityRepo = ReturnType<typeof globalIdentityRepo>;
