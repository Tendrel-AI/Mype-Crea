/**
 * Identity bootstrap repository. Resolves only an exact org/user pair inside
 * the candidate tenant's ordinary RLS context; it never provisions records.
 */
import { withTenantTransaction, type Tenant } from '../db/with-transaction';

export type TenantMembershipRole = 'admin' | 'member';

export interface TenantMembership {
  readonly userId: string;
  readonly role: TenantMembershipRole;
}

export function identityRepo(tenant: Tenant) {
  return {
    async resolveMember(
      organizationId: string,
      workosUserId: string,
    ): Promise<TenantMembership | undefined> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const result = await tx.query<{ user_id: string; role: TenantMembershipRole }>(
          `SELECT u.id AS user_id, u.role
             FROM tenants t
             JOIN users u ON u.tenant_id = t.id
            WHERE t.id = $1
              AND t.workos_org_id = $2
              AND u.workos_user_id = $3
              AND u.status = 'active'
            LIMIT 1`,
          [tenant.id, organizationId, workosUserId],
        );
        const row = result.rows[0];
        return row ? { userId: row.user_id, role: row.role } : undefined;
      });
    },
  };
}

export type IdentityRepo = ReturnType<typeof identityRepo>;
