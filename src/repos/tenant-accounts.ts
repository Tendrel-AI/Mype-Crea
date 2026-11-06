/**
 * KAN-41 tenant account management (`users` + `tenant_account_audit_events`). Every method runs
 * as the acting admin inside `withTenantTransaction(tenant, actor)` as app_user; each one first
 * checks `app.has_tenant_admin()` (persisted, active admin role) and RLS repeats that check on
 * every write. Tenant and role come from the session identity, never from the caller's input.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';

export type AccountStatus = 'active' | 'inactive';
export type AccountRole = 'admin' | 'member';
export type AccountAction = 'member.provision' | 'member.deactivate' | 'member.reactivate';
export type AccountOutcome = 'success' | 'refused' | 'failed';

export interface TenantMember {
  readonly id: UUID;
  readonly workosUserId: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly status: AccountStatus;
  readonly createdAt: string;
}

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

export type SetStatusResult =
  | { readonly kind: 'changed'; readonly member: TenantMember; readonly before: AccountStatus }
  | { readonly kind: 'unchanged'; readonly member: TenantMember }
  | { readonly kind: 'refused'; readonly code: 'not_found' | 'last_admin' };

/** The session user is not an active admin of the tenant (persisted role, checked in the DB). */
export class NotTenantAdminError extends Error {
  constructor() { super('Tenant admin required.'); }
}

export interface TenantAccountsRepo {
  listMembers(): Promise<ReadonlyArray<TenantMember>>;
  findMember(id: UUID): Promise<TenantMember | undefined>;
  findByEmail(email: string): Promise<TenantMember | undefined>;
  /** Insert an active `member` plus its success audit row in one transaction; idempotent by email. */
  addMember(input: { workosUserId: string; email: string; reason: string | null }): Promise<{ member: TenantMember; created: boolean }>;
  /**
   * Change one member's status with its audit row (success or refused) in one transaction.
   * Locks the tenant's active admins first, so two admins removing each other cannot leave the
   * tenant without one.
   */
  setStatus(input: { targetUserId: UUID; status: AccountStatus; reason: string | null }): Promise<SetStatusResult>;
  /** Standalone audit row for refusals and failures decided outside `setStatus`. */
  recordAudit(entry: AccountAuditEntry): Promise<void>;
  /** Newest first, at most `limit` (≤ 200). */
  listAudit(limit?: number): Promise<ReadonlyArray<AccountAuditRow>>;
}

interface MemberRowDb {
  id: UUID;
  workos_user_id: string;
  email: string;
  role: AccountRole;
  status: AccountStatus;
  created_at: Date;
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

const MEMBER_COLUMNS = 'id, workos_user_id, email, role, status, created_at';

function toMember(row: MemberRowDb): TenantMember {
  return {
    id: row.id,
    workosUserId: row.workos_user_id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
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

  async function selectMember(tx: TxClient, where: string, value: string, lock = ''): Promise<TenantMember | undefined> {
    const res = await tx.query<MemberRowDb>(
      `SELECT ${MEMBER_COLUMNS} FROM users WHERE tenant_id = $1 AND ${where} = $2 ${lock}`,
      [tenant.id, value],
    );
    return res.rows[0] ? toMember(res.rows[0]) : undefined;
  }

  const run = <T>(fn: (tx: TxClient) => Promise<T>) => withTenantTransaction(tenant, actor, async (tx) => {
    await assertAdmin(tx);
    return fn(tx);
  });

  return {
    listMembers: () => run(async (tx) => {
      const res = await tx.query<MemberRowDb>(
        `SELECT ${MEMBER_COLUMNS} FROM users WHERE tenant_id = $1 ORDER BY created_at, id`,
        [tenant.id],
      );
      return res.rows.map(toMember);
    }),

    findMember: (id) => run((tx) => selectMember(tx, 'id', id)),

    findByEmail: (email) => run((tx) => selectMember(tx, 'email', email)),

    addMember: ({ workosUserId, email, reason }) => run(async (tx) => {
      const inserted = await tx.query<MemberRowDb>(
        `INSERT INTO users (tenant_id, workos_user_id, email, role, status)
         VALUES ($1, $2, $3, 'member', 'active')
         ON CONFLICT DO NOTHING
         RETURNING ${MEMBER_COLUMNS}`,
        [tenant.id, workosUserId, email],
      );
      if (inserted.rows[0]) {
        const member = toMember(inserted.rows[0]);
        await insertAudit(tx, {
          action: 'member.provision', targetUserId: member.id, targetEmail: member.email,
          beforeStatus: null, afterStatus: 'active', reason, outcome: 'success', outcomeCode: null,
        });
        return { member, created: true };
      }
      // A concurrent or earlier provision won; the same email is the same account.
      const existing = await selectMember(tx, 'email', email);
      if (!existing) throw new Error('tenant_accounts.add_member_conflict');
      return { member: existing, created: false };
    }),

    setStatus: ({ targetUserId, status, reason }) => run(async (tx) => {
      const admins = await tx.query<{ id: UUID }>(
        `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE`,
        [tenant.id],
      );
      // Re-read under the lock: an admin deactivated by a concurrent call is no longer one.
      if (!admins.rows.some((row) => row.id === actor.id)) throw new NotTenantAdminError();
      const action: AccountAction = status === 'inactive' ? 'member.deactivate' : 'member.reactivate';
      const target = await selectMember(tx, 'id', targetUserId, 'FOR UPDATE');
      const refuse = async (code: 'not_found' | 'last_admin'): Promise<SetStatusResult> => {
        await insertAudit(tx, {
          action, targetUserId, targetEmail: target?.email ?? null, beforeStatus: target?.status ?? null,
          afterStatus: target?.status ?? null, reason, outcome: 'refused', outcomeCode: code,
        });
        return { kind: 'refused', code };
      };
      if (!target) return refuse('not_found');
      if (target.status === status) return { kind: 'unchanged', member: target };
      if (status === 'inactive' && target.role === 'admin' && admins.rows.length <= 1) return refuse('last_admin');
      await tx.query('UPDATE users SET status = $3 WHERE tenant_id = $1 AND id = $2', [tenant.id, target.id, status]);
      await insertAudit(tx, {
        action, targetUserId: target.id, targetEmail: target.email, beforeStatus: target.status,
        afterStatus: status, reason, outcome: 'success', outcomeCode: null,
      });
      return { kind: 'changed', member: { ...target, status }, before: target.status };
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
