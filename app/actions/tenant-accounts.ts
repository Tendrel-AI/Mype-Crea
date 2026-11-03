'use server';

/**
 * KAN-41 controllers for `/admin/accounts`. Every call re-resolves the live identity and requires
 * an effective tenant admin; tenant, actor and role come only from that identity. A refused
 * non-admin call is logged and touches nothing (the audit table accepts only admin rows).
 */
import { unstable_rethrow } from 'next/navigation';
import { requireTenantAdmin, TenantAdminRequiredError, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { NotTenantAdminError, type AccountAuditRow, type AccountRole, type AccountStatus } from '../../src/repos/tenant-accounts';
import { loggerFor } from '../../src/services/logger';
import { createWorkosAccountsClient, TenantAccountService, type AccountResult } from '../../src/services/tenant-accounts';

const log = loggerFor('actions.tenant-accounts');

const NOT_ADMIN: AccountResult = { ok: false, code: 'not_admin', message: 'No tienes permiso para administrar las cuentas de esta organización.' };
const FAILED: AccountResult = { ok: false, code: 'failed', message: 'No pudimos completar la acción. Vuelve a intentarlo.' };

export interface TenantAccountsView {
  readonly ok: boolean;
  readonly error?: string;
  readonly currentUserId?: string;
  readonly members?: ReadonlyArray<{ id: string; email: string; role: AccountRole; status: AccountStatus; createdAt: string }>;
  readonly audit?: ReadonlyArray<AccountAuditRow>;
}

async function asAdmin<T>(operation: string, refused: T, failed: T, work: (identity: ResolvedIdentity) => Promise<T>): Promise<T> {
  let identity: ResolvedIdentity;
  try {
    identity = await requireTenantAdmin();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TenantAdminRequiredError) {
      log.warn({ operation, tenantId: error.identity.tenant.id, userId: error.identity.user.id }, 'tenant_accounts.refused_not_admin');
      return refused;
    }
    return failed;
  }
  try {
    return await work(identity);
  } catch (error) {
    if (error instanceof NotTenantAdminError) {
      log.warn({ operation, tenantId: identity.tenant.id, userId: identity.user.id }, 'tenant_accounts.refused_not_admin_db');
      return refused;
    }
    log.error({ operation, tenantId: identity.tenant.id, err: error instanceof Error ? error.name : 'unknown' }, 'tenant_accounts.failed');
    return failed;
  }
}

function service(identity: ResolvedIdentity): TenantAccountService {
  return new TenantAccountService(repos(identity.tenant, identity.user).tenantAccounts, createWorkosAccountsClient());
}

function actor(identity: ResolvedIdentity) {
  return { tenant: identity.tenant, user: identity.user, organizationId: identity.organizationId };
}

export async function getTenantAccounts(): Promise<TenantAccountsView> {
  return asAdmin<TenantAccountsView>('list', { ok: false, error: NOT_ADMIN.message }, { ok: false, error: FAILED.message }, async (identity) => {
    const repo = repos(identity.tenant, identity.user).tenantAccounts;
    const [members, audit] = await Promise.all([repo.listMembers(), repo.listAudit(50)]);
    return {
      ok: true,
      currentUserId: identity.user.id,
      members: members.map(({ id, email, role, status, createdAt }) => ({ id, email, role, status, createdAt })),
      audit,
    };
  });
}

export async function provisionTenantMember(input: { email: string; reason?: string }): Promise<AccountResult> {
  return asAdmin('provision', NOT_ADMIN, FAILED, (identity) => service(identity).provision(actor(identity), { email: input?.email, reason: input?.reason }));
}

export async function deactivateTenantMember(input: { userId: string; reason?: string }): Promise<AccountResult> {
  return asAdmin('deactivate', NOT_ADMIN, FAILED, (identity) => service(identity).deactivate(actor(identity), { userId: input?.userId, reason: input?.reason }));
}

export async function reactivateTenantMember(input: { userId: string; reason?: string }): Promise<AccountResult> {
  return asAdmin('reactivate', NOT_ADMIN, FAILED, (identity) => service(identity).reactivate(actor(identity), { userId: input?.userId, reason: input?.reason }));
}
