import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  memberships: vi.fn(),
  resolveMember: vi.fn(),
}));

vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: mocks.auth,
  getWorkOS: () => ({
    userManagement: { listOrganizationMemberships: mocks.memberships },
  }),
}));
vi.mock('../../repos', () => ({
  systemRepos: vi.fn(() => ({ identity: { resolveMember: mocks.resolveMember } })),
}));
vi.mock('../../services/logger', () => ({
  loggerFor: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

import { requirePlatformAdmin, requireTenantAdmin, resolveIdentity, verifyActiveMembership } from '../resolve-identity';

const originalOrganizationTenants = process.env.WORKOS_ORGANIZATION_TENANTS;
const originalPlatformAdmins = process.env.PLATFORM_ADMIN_WORKOS_USER_IDS;
const orgA = 'org_a';
const orgB = 'org_b';
const userId = 'user_1';
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const localUserId = '33333333-3333-4333-8333-333333333333';

function activeMembership(organizationId: string, memberUserId = userId) {
  return { data: [{ organizationId, userId: memberUserId, status: 'active' }] };
}

describe('resolveIdentity', () => {
  beforeEach(() => {
    process.env.WORKOS_ORGANIZATION_TENANTS = JSON.stringify({ [orgA]: tenantA, [orgB]: tenantB });
    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = '';
    mocks.auth.mockResolvedValue({ user: { id: userId, email: 'user@example.test' }, organizationId: orgA });
    mocks.memberships.mockImplementation(({ organizationId }: { organizationId: string }) => activeMembership(organizationId));
    mocks.resolveMember.mockResolvedValue({ userId: localUserId, role: 'member' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalOrganizationTenants === undefined) delete process.env.WORKOS_ORGANIZATION_TENANTS;
    else process.env.WORKOS_ORGANIZATION_TENANTS = originalOrganizationTenants;
    if (originalPlatformAdmins === undefined) delete process.env.PLATFORM_ADMIN_WORKOS_USER_IDS;
    else process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = originalPlatformAdmins;
  });

  it('routes each authenticated WorkOS organization only to its configured tenant', async () => {
    const first = await resolveIdentity();
    expect(first.tenant.id).toBe(tenantA);
    expect(mocks.resolveMember).toHaveBeenCalledWith(orgA, userId);

    mocks.auth.mockResolvedValueOnce({ user: { id: userId }, organizationId: orgB });
    const second = await resolveIdentity();
    expect(second.tenant.id).toBe(tenantB);
    expect(mocks.resolveMember).toHaveBeenLastCalledWith(orgB, userId);
  });

  it('ignores forged caller-supplied organization and tenant values', async () => {
    const callWithUntrustedInput = resolveIdentity as (...args: unknown[]) => ReturnType<typeof resolveIdentity>;
    const identity = await callWithUntrustedInput({ organizationId: orgB, tenantId: tenantB });
    expect(identity.organizationId).toBe(orgA);
    expect(identity.tenant.id).toBe(tenantA);
    expect(mocks.resolveMember).toHaveBeenCalledWith(orgA, userId);
  });

  it('rejects missing or unconfigured organization without querying tenant membership', async () => {
    mocks.auth.mockResolvedValueOnce({ user: { id: userId } });
    await expect(resolveIdentity()).rejects.toThrow('Tu sesión no tiene una organización activa.');

    mocks.auth.mockResolvedValueOnce({ user: { id: userId }, organizationId: 'org_unknown' });
    await expect(resolveIdentity()).rejects.toThrow('La organización de tu cuenta no está habilitada.');
    expect(mocks.resolveMember).not.toHaveBeenCalled();
  });

  it('rejects invalid routing configuration and never provisions a local user', async () => {
    process.env.WORKOS_ORGANIZATION_TENANTS = '{invalid';
    await expect(resolveIdentity()).rejects.toThrow('La configuración de acceso a organizaciones no es válida.');
    expect(mocks.memberships).not.toHaveBeenCalled();

    process.env.WORKOS_ORGANIZATION_TENANTS = `{"__proto__":"${tenantA}"}`;
    await expect(resolveIdentity()).rejects.toThrow('La configuración de acceso a organizaciones no es válida.');
    expect(mocks.memberships).not.toHaveBeenCalled();

    process.env.WORKOS_ORGANIZATION_TENANTS = JSON.stringify({ [orgA]: tenantA });
    mocks.resolveMember.mockResolvedValueOnce(undefined);
    await expect(resolveIdentity()).rejects.toThrow('Tu cuenta no tiene acceso activo a esta organización.');
    expect(mocks.resolveMember).toHaveBeenCalledWith(orgA, userId);
  });

  it('requires an active WorkOS membership and fails closed on WorkOS errors', async () => {
    mocks.memberships.mockResolvedValueOnce({
      data: [{ organizationId: orgA, userId, status: 'inactive' }],
    });
    await expect(resolveIdentity()).rejects.toThrow('Tu cuenta no tiene acceso activo a esta organización.');
    expect(mocks.resolveMember).not.toHaveBeenCalled();

    mocks.memberships.mockRejectedValueOnce(new Error('remote failure'));
    await expect(resolveIdentity()).rejects.toThrow('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.');
    expect(mocks.resolveMember).not.toHaveBeenCalled();
  });

  it('returns the database tenant role and keeps platform allowlist separate', async () => {
    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = ' user_other, user_1 ';
    mocks.resolveMember.mockResolvedValueOnce({ userId: localUserId, role: 'admin' });
    const identity = await resolveIdentity();
    expect(identity).toMatchObject({
      tenantRole: 'admin',
      platformAdmin: true,
      workosUserId: userId,
      organizationId: orgA,
    });
  });

  it('rejects malformed platform allowlist entries without contacting WorkOS', async () => {
    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = 'user_valid,not-a-workos-id';
    await expect(resolveIdentity()).rejects.toThrow('La configuración de acceso de plataforma no es válida.');
    expect(mocks.memberships).not.toHaveBeenCalled();
  });

  it('does not treat platform status as tenant admin or tenant admin as platform admin', async () => {
    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = userId;
    await expect(requireTenantAdmin()).rejects.toThrow('No tienes permiso para administrar la configuración de esta organización.');

    process.env.PLATFORM_ADMIN_WORKOS_USER_IDS = '';
    mocks.resolveMember.mockResolvedValueOnce({ userId: localUserId, role: 'admin' });
    await expect(requirePlatformAdmin()).rejects.toThrow('No tienes permiso para administrar la configuración de la plataforma.');
  });

  it('revalidates captured WorkOS and local membership for long-lived streams', async () => {
    await expect(verifyActiveMembership({
      organizationId: orgA,
      workosUserId: userId,
      tenantId: tenantA,
      userId: localUserId,
    })).resolves.toBe(true);

    mocks.resolveMember.mockResolvedValueOnce({ userId: '44444444-4444-4444-8444-444444444444', role: 'member' });
    await expect(verifyActiveMembership({
      organizationId: orgA,
      workosUserId: userId,
      tenantId: tenantA,
      userId: localUserId,
    })).resolves.toBe(false);

    mocks.memberships.mockRejectedValueOnce(new Error('remote failure'));
    await expect(verifyActiveMembership({
      organizationId: orgA,
      workosUserId: userId,
      tenantId: tenantA,
      userId: localUserId,
    })).resolves.toBe(false);
    await expect(verifyActiveMembership({
      organizationId: '__proto__',
      workosUserId: userId,
      tenantId: tenantA,
      userId: localUserId,
    })).resolves.toBe(false);
  });
});
