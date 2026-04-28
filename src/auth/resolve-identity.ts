/**
 * Resolves a WorkOS-authenticated request to a `Tenant` and `User` row in
 * our database. Every server action that calls `repos(...)` must go through
 * this helper — it is the only place that bridges WorkOS identity to the
 * tenant_id / user_id values that drive RLS.
 *
 * Pilot scope limitation: a single institutional tenant, read from
 * `PILOT_TENANT_ID`. Production multi-tenant lookup (e.g. WorkOS org id →
 * tenants.workos_org_id) requires a `tenantsRepo` plus a platform-admin
 * GUC/policy; that's a follow-up. The seam is documented here so it's
 * obvious where to plug in.
 */
import { withAuth } from '@workos-inc/authkit-nextjs';
import { withTenantAdminTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';

const log = loggerFor('auth.resolve-identity');

export interface ResolvedIdentity {
  readonly tenant: Tenant;
  readonly user: User;
}

export async function resolveIdentity(): Promise<ResolvedIdentity> {
  log.info('identity.resolve.start');
  const { user: workosUser } = await withAuth({ ensureSignedIn: true });
  log.info(
    { workosUserId: workosUser.id, email: workosUser.email },
    'identity.resolve.workos_user_loaded',
  );

  const tenantId = process.env.PILOT_TENANT_ID;
  if (!tenantId) {
    log.error('identity.resolve.missing_pilot_tenant_id');
    throw new Error(
      'PILOT_TENANT_ID is not set. resolveIdentity needs the pilot tenant id ' +
        'to bootstrap the (tenant_id, user_id) mapping for a WorkOS user.',
    );
  }
  const tenant: Tenant = { id: tenantId };
  log.info({ tenantId }, 'identity.resolve.tenant_resolved');

  // Upsert the user under this tenant. Admin tx is required because the
  // user row may not exist yet, and the user-axis RLS check would otherwise
  // hide it from us. Tenant axis is still enforced.
  const { userId, created } = await withTenantAdminTransaction(tenant, async (tx) => {
    const sel = await tx.query<{ id: string }>(
      `SELECT id FROM users
        WHERE tenant_id = $1
          AND workos_user_id = $2
        LIMIT 1`,
      [tenant.id, workosUser.id],
    );
    if (sel.rows.length) {
      return { userId: sel.rows[0].id, created: false };
    }
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO users (tenant_id, workos_user_id, email)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenant.id, workosUser.id, workosUser.email],
    );
    return { userId: ins.rows[0].id, created: true };
  });

  log.info(
    { tenantId, userId, workosUserId: workosUser.id, created },
    created ? 'identity.resolve.user_created' : 'identity.resolve.user_found',
  );
  return { tenant, user: { id: userId } };
}
