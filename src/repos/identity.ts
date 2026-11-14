/**
 * Identity bootstrap repository. Resolves an exact org/user pair inside the candidate tenant's
 * ordinary RLS context. The only write is `syncMember` (D52): the narrow `app.sync_member`
 * SECURITY DEFINER function that keeps the local `users` mirror of a WorkOS membership.
 */
import { withTenantTransaction, type Tenant } from '../db/with-transaction';

export type TenantMembershipRole = 'admin' | 'member';

export interface TenantMembership {
  readonly userId: string;
  readonly role: TenantMembershipRole;
  /** Local mirror status; an inactive row is a local block that wins over WorkOS. */
  readonly status: 'active' | 'inactive';
}

export type SyncMemberOutcome = 'existing' | 'relinked' | 'created' | 'denied_inactive';

export function identityRepo(tenant: Tenant) {
  return {
    /** D43: the user's live status. False when the user is inactive or does not exist (fail closed). */
    async isUserActive(userId: string): Promise<boolean> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const result = await tx.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [tenant.id, userId]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    /** Read-only lookup of the mirror row, any status. Callers must check `status`. */
    async resolveMember(
      organizationId: string,
      workosUserId: string,
    ): Promise<TenantMembership | undefined> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const result = await tx.query<{ user_id: string; role: TenantMembershipRole; status: 'active' | 'inactive' }>(
          `SELECT u.id AS user_id, u.role, u.status
             FROM tenants t
             JOIN users u ON u.tenant_id = t.id
            WHERE t.id = $1
              AND t.workos_org_id = $2
              AND u.workos_user_id = $3
            LIMIT 1`,
          [tenant.id, organizationId, workosUserId],
        );
        const row = result.rows[0];
        return row ? { userId: row.user_id, role: row.role, status: row.status } : undefined;
      });
    },

    /** D52: insert / relink / role-sync the mirror row. Never activates an inactive row. */
    async syncMember(input: {
      workosUserId: string;
      email: string;
      emailVerified: boolean;
      role: TenantMembershipRole;
    }): Promise<(TenantMembership & { outcome: SyncMemberOutcome }) | undefined> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const result = await tx.query<{ o_user_id: string; o_role: TenantMembershipRole; o_status: 'active' | 'inactive'; o_outcome: SyncMemberOutcome }>(
          'SELECT * FROM app.sync_member($1, $2, $3, $4)',
          [input.workosUserId, input.email, input.emailVerified, input.role],
        );
        const row = result.rows[0];
        return row ? { userId: row.o_user_id, role: row.o_role, status: row.o_status, outcome: row.o_outcome } : undefined;
      });
    },
  };
}

export type IdentityRepo = ReturnType<typeof identityRepo>;
