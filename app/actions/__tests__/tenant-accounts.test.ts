/**
 * KAN-41 controllers: a non-admin caller is refused and logged before any repository or WorkOS
 * call; an admin's tenant and actor come only from the session identity (forged input keys are
 * ignored); a repository-level admin refusal (persisted role) is answered the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireTenantAdmin: vi.fn(),
  repos: vi.fn(),
  workosClient: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/auth/resolve-identity', () => {
  class TenantAdminRequiredError extends Error {
    constructor(readonly identity: unknown) { super('not admin'); }
  }
  return { requireTenantAdmin: mocks.requireTenantAdmin, TenantAdminRequiredError };
});
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/services/logger', () => ({
  loggerFor: () => ({ warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@workos-inc/authkit-nextjs', () => ({ getWorkOS: vi.fn() }));
vi.mock('../../../src/services/tenant-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/tenant-accounts')>()),
  createWorkosAccountsClient: mocks.workosClient,
}));

import { TenantAdminRequiredError } from '../../../src/auth/resolve-identity';
import { NotTenantAdminError } from '../../../src/repos/tenant-accounts';
import { deactivateTenantMember, getTenantAccounts, provisionTenantMember, reactivateTenantMember } from '../tenant-accounts';

const TENANT = { id: '11111111-1111-4111-8111-111111111111' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222' };
const identity = (tenantRole: 'admin' | 'member') => ({ tenant: TENANT, user: ADMIN, tenantRole, organizationId: 'org_A', workosUserId: 'user_A', platformAdmin: false });

const NOT_ADMIN = 'No tienes permiso para administrar las cuentas de esta organización.';

describe('tenant account actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a member on every action, logs it, and never builds a repository or WorkOS client', async () => {
    mocks.requireTenantAdmin.mockRejectedValue(new TenantAdminRequiredError(identity('member')));
    const results = [
      await provisionTenantMember({ email: 'ana@ejemplo.pe' }),
      await deactivateTenantMember({ userId: ADMIN.id }),
      await reactivateTenantMember({ userId: ADMIN.id }),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, code: 'not_admin', message: NOT_ADMIN });
    expect(await getTenantAccounts()).toEqual({ ok: false, error: NOT_ADMIN });
    expect(mocks.repos).not.toHaveBeenCalled();
    expect(mocks.workosClient).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(4);
    expect(mocks.warn.mock.calls.map((call) => call[1])).toEqual(Array(4).fill('tenant_accounts.refused_not_admin'));
    expect(mocks.warn.mock.calls[0][0]).toMatchObject({ operation: 'provision', tenantId: TENANT.id, userId: ADMIN.id });
  });

  it('derives tenant and actor from the identity, ignoring forged keys in the input', async () => {
    mocks.requireTenantAdmin.mockResolvedValue(identity('admin'));
    const repo = { findByEmail: vi.fn(async () => undefined), addMember: vi.fn(async (input: { email: string }) => ({ member: { email: input.email }, created: true })) };
    mocks.repos.mockReturnValue({ tenantAccounts: repo });
    mocks.workosClient.mockReturnValue({ ensureUser: vi.fn(async () => ({ id: 'user_new' })), activateMembership: vi.fn(async () => undefined) });
    const forged = { email: 'ana@ejemplo.pe', tenantId: 'other', tenant: { id: 'other' }, role: 'admin' } as unknown as { email: string };
    expect(await provisionTenantMember(forged)).toMatchObject({ ok: true, code: 'provisioned' });
    expect(mocks.repos).toHaveBeenCalledWith(TENANT, ADMIN);
    expect(repo.addMember).toHaveBeenCalledWith({ workosUserId: 'user_new', email: 'ana@ejemplo.pe', reason: null });
    const workos = mocks.workosClient.mock.results[0].value;
    expect(workos.activateMembership).toHaveBeenCalledWith('org_A', 'user_new');
  });

  it('answers a persisted-role refusal from the repository as not_admin', async () => {
    mocks.requireTenantAdmin.mockResolvedValue(identity('admin'));
    mocks.repos.mockReturnValue({ tenantAccounts: { listMembers: vi.fn(async () => { throw new NotTenantAdminError(); }), listAudit: vi.fn(async () => []) } });
    expect(await getTenantAccounts()).toEqual({ ok: false, error: NOT_ADMIN });
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ operation: 'list' }), 'tenant_accounts.refused_not_admin_db');
  });

  it('lists members without WorkOS ids', async () => {
    mocks.requireTenantAdmin.mockResolvedValue(identity('admin'));
    const member = { id: ADMIN.id, workosUserId: 'user_A', email: 'admin@ejemplo.pe', role: 'admin', status: 'active', createdAt: '2026-11-02T00:00:00.000Z' };
    mocks.repos.mockReturnValue({ tenantAccounts: { listMembers: vi.fn(async () => [member]), listAudit: vi.fn(async () => []) } });
    const view = await getTenantAccounts();
    expect(view).toMatchObject({ ok: true, currentUserId: ADMIN.id, audit: [] });
    expect(view.members).toEqual([{ id: ADMIN.id, email: 'admin@ejemplo.pe', role: 'admin', status: 'active', createdAt: '2026-11-02T00:00:00.000Z' }]);
  });
});
