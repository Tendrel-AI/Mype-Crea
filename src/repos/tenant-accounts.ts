/**
 * KAN-41 / D52 tenant account management. Membership and role live in WorkOS; this repo only
 * flips the local `users` mirror status (the block workers and the usage gateway read) and writes
 * `tenant_account_audit_events`. Every method runs as the acting admin inside
 * `withTenantTransaction(tenant, actor)` as app_user; each one first checks `app.has_tenant_admin()`
 * and RLS repeats that check on every write. Tenant comes from the session identity.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';

export type AccountStatus = 'active' | 'inactive';
export type AccountRole = 'admin' | 'member';
export type AccountAction = 'member.provision' | 'member.deactivate' | 'member.reactivate';
export type AccountOutcome = 'success' | 'refused' | 'failed';

export interface AccountAuditEntry {
  readonly action: AccountAction;
  readonly targetUserId: UUID | null;
  readonly targetEmail: string | null;
  readonly beforeStatus: AccountStatus | null;
  readonly afterStatus: AccountStatus | null;
  readonly reason: string | null;
  readonly outcome: AccountOutcome;
  /** Safe identifier (`^[a-z][a-z0-9_]{0,63}$`); null exactly when the outcome is success. */
  readonly outcomeCode: string | null;
}

export interface AccountAuditRow extends AccountAuditEntry {
  readonly id: UUID;
  readonly actorUserId: UUID;
  readonly createdAt: string;
}

/** The session user is not an active admin of the tenant (persisted role, checked in the DB). */
export class NotTenantAdminError extends Error {
  constructor() { super('Tenant admin required.'); }
}

export interface TenantAccountsRepo {
  /**
   * Set the local mirror status of a member found by WorkOS user id. Returns the local user id, or
   * undefined when the person never signed in (no row yet: nothing to block).
   */
  setMirrorStatus(input: { workosUserId: string; status: AccountStatus }): Promise<{ userId: UUID } | undefined>;
  /** Standalone audit row for refusals and failures decided outside `setStatus`. */
  recordAudit(entry: AccountAuditEntry): Promise<void>;
  /** Newest first, at most `limit` (≤ 200). */
  listAudit(limit?: number): Promise<ReadonlyArray<AccountAuditRow>>;
}

interface AuditRowDb {
  id: UUID;
  actor_user_id: UUID;
  action: AccountAction;
  target_user_id: UUID | null;
  target_email: string | null;
  before_status: AccountStatus | null;
  after_status: AccountStatus | null;
  reason: string | null;
  outcome: AccountOutcome;
  outcome_code: string | null;
  created_at: Date;
}

export function tenantAccountsRepo(tenant: Tenant, actor: User): TenantAccountsRepo {
  async function assertAdmin(tx: TxClient): Promise<void> {
    const res = await tx.query<{ ok: boolean }>('SELECT app.has_tenant_admin() AS ok');
    if (!res.rows[0]?.ok) throw new NotTenantAdminError();
  }

  async function insertAudit(tx: TxClient, entry: AccountAuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO tenant_account_audit_events
         (tenant_id, actor_user_id, action, target_user_id, target_email, before_status, after_status, reason, outcome, outcome_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenant.id, actor.id, entry.action, entry.targetUserId, entry.targetEmail, entry.beforeStatus, entry.afterStatus, entry.reason, entry.outcome, entry.outcomeCode],
    );
  }

  const run = <T>(fn: (tx: TxClient) => Promise<T>) => withTenantTransaction(tenant, actor, async (tx) => {
    await assertAdmin(tx);
    return fn(tx);
  });

  return {
    setMirrorStatus: ({ workosUserId, status }) => run(async (tx) => {
      const res = await tx.query<{ id: UUID }>(
        'UPDATE users SET status = $3 WHERE tenant_id = $1 AND workos_user_id = $2 RETURNING id',
        [tenant.id, workosUserId, status],
      );
      return res.rows[0] ? { userId: res.rows[0].id } : undefined;
    }),

    recordAudit: (entry) => run((tx) => insertAudit(tx, entry)),

    listAudit: (limit = 50) => run(async (tx) => {
      const res = await tx.query<AuditRowDb>(
        `SELECT id, actor_user_id, action, target_user_id, target_email, before_status, after_status, reason, outcome, outcome_code, created_at
           FROM tenant_account_audit_events
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [tenant.id, Math.min(Math.max(1, Math.trunc(limit)), 200)],
      );
      return res.rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        action: row.action,
        targetUserId: row.target_user_id,
        targetEmail: row.target_email,
        beforeStatus: row.before_status,
        afterStatus: row.after_status,
        reason: row.reason,
        outcome: row.outcome,
        outcomeCode: row.outcome_code,
        createdAt: row.created_at.toISOString(),
      }));
    }),
  };
}
