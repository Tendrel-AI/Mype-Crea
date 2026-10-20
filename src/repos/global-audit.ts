import { withGlobalTransaction, type GlobalTxClient } from '../db/global-transaction';

export interface GlobalAuditEvent {
  readonly actorWorkosUserId: string | null;
  readonly action: string;
  readonly scopeType: string;
  readonly scopeId?: string | null;
  readonly priorVersion?: string | null;
  readonly newVersion?: string | null;
  readonly outcome: 'success' | 'failure';
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export async function assertActivePlatformActor(
  tx: GlobalTxClient,
  actorWorkosUserId: string,
): Promise<void> {
  const result = await tx.query<{ authorized: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM platform_superadmins
      WHERE workos_user_id = $1 AND revoked_at IS NULL) AS authorized`, [actorWorkosUserId],
  );
  if (!result.rows[0]?.authorized) throw new Error('Platform administrator authorization is required.');
  await tx.query(`SELECT set_config('app.platform_actor_workos_user_id', $1, true)`, [actorWorkosUserId]);
}

export async function insertGlobalAuditEvent(
  tx: GlobalTxClient,
  event: GlobalAuditEvent,
): Promise<void> {
  await tx.query(
    `INSERT INTO platform_audit_events
      (actor_workos_user_id, action, scope_type, scope_id, prior_version, new_version, outcome, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [event.actorWorkosUserId, event.action, event.scopeType, event.scopeId ?? null,
      event.priorVersion ?? null, event.newVersion ?? null, event.outcome, event.reason ?? null,
      JSON.stringify(event.metadata ?? {})],
  );
}

export function globalAuditRepo() {
  return {
    async record(event: GlobalAuditEvent): Promise<void> {
      await withGlobalTransaction(async (tx) => {
        if (event.actorWorkosUserId) await assertActivePlatformActor(tx, event.actorWorkosUserId);
        await insertGlobalAuditEvent(tx, event);
      });
    },
  };
}

export type GlobalAuditRepo = ReturnType<typeof globalAuditRepo>;
