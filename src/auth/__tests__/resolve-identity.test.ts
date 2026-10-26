import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  memberships: vi.fn(),
  resolveMember: vi.fn(),
  isSuperadmin: vi.fn(),
  bootstrapSuperadmin: vi.fn(),
  findByWorkosOrgId: vi.fn(),
  organizationIsActive: vi.fn(),
  cookieGet: vi.fn<(name: string) => { value: string } | undefined>(() => undefined),
  logInfo: vi.fn(),
  // Role checks (users / platform_superadmins) pass; catalog reads return no rows.
  txQuery: vi.fn(async (sql: string, _params?: readonly unknown[]) => (sql.includes('ai_shared_releases') ? { rows: [], rowCount: 0 } : { rows: [{ ok: 1 }], rowCount: 1 })),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: vi.fn(async (_tenant: unknown, _user: unknown, callback: (tx: unknown) => unknown) => callback({ query: mocks.txQuery })),
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
vi.mock('../../repos/global', () => ({
  globalRepos: () => ({
    identity: { isSuperadmin: mocks.isSuperadmin, bootstrapSuperadmin: mocks.bootstrapSuperadmin },
    organizations: { findByWorkosOrgId: mocks.findByWorkosOrgId, isActive: mocks.organizationIsActive },
  }),
}));
vi.mock('../../services/logger', () => ({
  loggerFor: () => ({
    info: mocks.logInfo,
    error: vi.fn(),
  }),
}));

import { getRoleSwitcherState, repositoryActor, requireGlobalAdmin, requireGlobalMfa, requirePlatformAdmin, requirePlatformStepUp, requireTenantAdmin, resolveIdentity, signMfaPending, signMfaProof, verifyActiveMembership, verifyMfaPending } from '../resolve-identity';
import { aiConfigRepo } from '../../repos/ai-config';
import { LEGACY_MFA_PROOF_COOKIE, MFA_PROOF_COOKIE, MfaRequiredError } from '../platform-mfa';

const originalBootstrapId = process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID;
const originalCookiePassword = process.env.WORKOS_COOKIE_PASSWORD;
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
    delete process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID;
    process.env.WORKOS_COOKIE_PASSWORD = 'test-session-cookie-password-that-is-long-enough';
    mocks.auth.mockResolvedValue({ user: { id: userId, email: 'user@example.test' }, organizationId: orgA, sessionId: 'session_1' });
    mocks.memberships.mockImplementation(({ organizationId }: { organizationId: string }) => activeMembership(organizationId));
    mocks.resolveMember.mockResolvedValue({ userId: localUserId, role: 'member' });
    mocks.isSuperadmin.mockResolvedValue(false);
    mocks.bootstrapSuperadmin.mockResolvedValue('granted');
    mocks.findByWorkosOrgId.mockImplementation(async (id: string) => id === orgA || id === orgB ? { tenantId: id === orgA ? tenantA : tenantB, status: 'active' } : undefined);
    mocks.organizationIsActive.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalBootstrapId === undefined) delete process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID;
    else process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID = originalBootstrapId;
    if (originalCookiePassword === undefined) delete process.env.WORKOS_COOKIE_PASSWORD;
    else process.env.WORKOS_COOKIE_PASSWORD = originalCookiePassword;
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
    mocks.auth.mockResolvedValueOnce({ user: { id: userId }, sessionId: 'session_1' });
    await expect(resolveIdentity()).rejects.toThrow('Tu sesión no tiene una organización activa.');

    mocks.auth.mockResolvedValueOnce({ user: { id: userId }, organizationId: 'org_unknown', sessionId: 'session_1' });
    await expect(resolveIdentity()).rejects.toThrow('La organización de tu cuenta no está habilitada.');
    expect(mocks.resolveMember).not.toHaveBeenCalled();
  });

  it('requires a registered organization and never provisions a local user', async () => {
    mocks.findByWorkosOrgId.mockResolvedValueOnce(undefined);
    await expect(resolveIdentity()).rejects.toThrow('La organización de tu cuenta no está habilitada.');
    expect(mocks.memberships).not.toHaveBeenCalled();
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

  it('returns the database tenant role and persisted platform role separately', async () => {
    mocks.resolveMember.mockResolvedValueOnce({ userId: localUserId, role: 'admin' });
    mocks.isSuperadmin.mockResolvedValueOnce(true);
    const identity = await resolveIdentity();
    expect(identity).toMatchObject({
      tenantRole: 'admin',
      platformAdmin: true,
      workosUserId: userId,
      organizationId: orgA,
    });
  });

  it('does not treat tenant admin status as platform authority', async () => {
    await expect(requireTenantAdmin()).rejects.toThrow('No tienes permiso para administrar la configuración de esta organización.');

    mocks.isSuperadmin.mockResolvedValueOnce(true);
    mocks.resolveMember.mockResolvedValueOnce({ userId: localUserId, role: 'admin' });
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ platformAdmin: true, tenantRole: 'admin' });
  });

  it('bootstraps only the configured signed-in user and rechecks persisted authorization', async () => {
    process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID = userId;
    mocks.isSuperadmin.mockResolvedValueOnce(false);
    await expect(requireGlobalAdmin()).rejects.toThrow('No tienes permiso para administrar la plataforma.');
    expect(mocks.bootstrapSuperadmin).toHaveBeenCalledWith(userId);

    process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID = 'user_someone_else';
    mocks.isSuperadmin.mockResolvedValueOnce(true);
    await expect(requireGlobalAdmin()).resolves.toMatchObject({ workosUserId: userId, sessionId: 'session_1' });
    expect(mocks.bootstrapSuperadmin).toHaveBeenCalledTimes(1);
  });

  it('supports a no-organization global session and binds MFA proof to that WorkOS session', async () => {
    process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID = userId;
    mocks.auth.mockResolvedValueOnce({ user: { id: userId }, sessionId: 'global_session' });
    mocks.isSuperadmin.mockResolvedValueOnce(true);
    await expect(requireGlobalAdmin()).resolves.toEqual({ workosUserId: userId, sessionId: 'global_session' });

    const proof = signMfaProof({ workosUserId: userId, sessionId: 'global_session' });
    const pending = signMfaPending({ workosUserId: userId, sessionId: 'global_session' }, 'challenge_1', 'factor_1');
    expect(verifyMfaPending(pending, { workosUserId: userId, sessionId: 'global_session' })).toEqual({ challengeId: 'challenge_1', factorId: 'factor_1' });
    expect(verifyMfaPending(pending, { workosUserId: userId, sessionId: 'different_session' })).toBeUndefined();
    expect(verifyMfaPending(proof, { workosUserId: userId, sessionId: 'global_session' })).toBeUndefined();
  });

  it('blocks deactivated organizations and stream membership rechecks', async () => {
    mocks.findByWorkosOrgId.mockResolvedValueOnce({ tenantId: tenantA, status: 'inactive' });
    await expect(resolveIdentity()).rejects.toThrow('El acceso a esta organización está pausado.');
    mocks.organizationIsActive.mockResolvedValueOnce(false);
    await expect(verifyActiveMembership({ organizationId: orgA, workosUserId: userId, tenantId: tenantA, userId: localUserId })).resolves.toBe(false);
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

describe('developer role override (KAN-79)', () => {
  const originalDevelopment = process.env.DEVELOPMENT;
  const cookie = (value: string | undefined) => mocks.cookieGet.mockImplementation((name: string) =>
    name === 'cremype_dev_role_override' && value !== undefined ? { value } : undefined);

  beforeEach(() => {
    delete process.env.PLATFORM_BOOTSTRAP_SUPERADMIN_WORKOS_USER_ID;
    process.env.WORKOS_COOKIE_PASSWORD = 'test-session-cookie-password-that-is-long-enough';
    process.env.DEVELOPMENT = 'TRUE';
    mocks.auth.mockResolvedValue({ user: { id: userId, email: 'user@example.test' }, organizationId: orgA, sessionId: 'session_1' });
    mocks.memberships.mockImplementation(({ organizationId }: { organizationId: string }) => activeMembership(organizationId));
    mocks.resolveMember.mockResolvedValue({ userId: localUserId, role: 'admin' });
    mocks.isSuperadmin.mockResolvedValue(true);
    mocks.findByWorkosOrgId.mockResolvedValue({ tenantId: tenantA, status: 'active' });
    cookie(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalDevelopment === undefined) delete process.env.DEVELOPMENT;
    else process.env.DEVELOPMENT = originalDevelopment;
    if (originalCookiePassword === undefined) delete process.env.WORKOS_COOKIE_PASSWORD;
    else process.env.WORKOS_COOKIE_PASSWORD = originalCookiePassword;
  });

  it('ignores the cookie entirely when DEVELOPMENT is off', async () => {
    process.env.DEVELOPMENT = 'false';
    cookie(`v1.${userId}.tenant-member+no-platform-admin`);
    const identity = await resolveIdentity();
    expect(identity).toMatchObject({ tenantRole: 'admin', platformAdmin: true });
    expect(identity.reducedFrom).toBeUndefined();
    expect(mocks.cookieGet).not.toHaveBeenCalled();
    await expect(requireTenantAdmin()).resolves.toMatchObject({ tenantRole: 'admin' });
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ platformAdmin: true });
    await expect(requireGlobalAdmin()).resolves.toMatchObject({ workosUserId: userId });
    await expect(getRoleSwitcherState()).resolves.toBeNull();
  });

  it('applies a tenant downgrade to resolveIdentity and requireTenantAdmin, logging real and effective roles', async () => {
    cookie(`v1.${userId}.tenant-member`);
    const identity = await resolveIdentity();
    expect(identity).toMatchObject({ tenant: { id: tenantA }, user: { id: localUserId }, workosUserId: userId, tenantRole: 'member', platformAdmin: true });
    expect(identity.reducedFrom).toEqual({ tenantRole: 'admin', platformAdmin: true });
    await expect(requireTenantAdmin()).rejects.toThrow('No tienes permiso para administrar la configuración de esta organización.');
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ platformAdmin: true, tenantRole: 'member' });
    expect(mocks.logInfo).toHaveBeenCalledWith(expect.objectContaining({
      userId: localUserId,
      real: { tenantRole: 'admin', platformAdmin: true },
      effective: { tenantRole: 'member', platformAdmin: true },
    }), 'auth.role_override.applied');
  });

  it('applies a platform downgrade to requirePlatformAdmin and the global console gate', async () => {
    cookie(`v1.${userId}.no-platform-admin`);
    await expect(resolveIdentity()).resolves.toMatchObject({ tenantRole: 'admin', platformAdmin: false });
    await expect(requirePlatformAdmin()).rejects.toThrow('No tienes permiso para administrar la configuración de la plataforma.');
    await expect(requireTenantAdmin()).resolves.toMatchObject({ tenantRole: 'admin' });
    await expect(requireGlobalAdmin()).rejects.toThrow('No tienes permiso para administrar la plataforma.');
    await expect(requireGlobalMfa()).rejects.toThrow('No tienes permiso para administrar la plataforma.');
  });

  it('keeps the platform MFA step-up for a real platform admin acting with reduced roles', async () => {
    cookie(`v1.${userId}.no-platform-admin`);
    const reduced = await resolveIdentity();
    await expect(requirePlatformStepUp(reduced)).rejects.toThrow('Verifica tu código de autenticación para continuar.');
    await expect(requirePlatformStepUp(reduced)).rejects.toBeInstanceOf(MfaRequiredError);
    const proof = signMfaProof({ workosUserId: userId, sessionId: 'session_1' });
    mocks.cookieGet.mockImplementation((name: string) => {
      if (name === 'cremype_dev_role_override') return { value: `v1.${userId}.no-platform-admin` };
      if (name === MFA_PROOF_COOKIE) return { value: proof };
      return undefined;
    });
    await expect(requirePlatformStepUp(reduced)).resolves.toBeUndefined();

    mocks.resolveMember.mockResolvedValueOnce({ userId: localUserId, role: 'member' });
    mocks.isSuperadmin.mockResolvedValue(false);
    const plainMember = await resolveIdentity();
    await expect(requirePlatformStepUp(plainMember)).resolves.toBeUndefined();
  });

  it('reads the proof only from the root-scoped cookie, never the legacy /platform one (KAN-80)', async () => {
    const proof = signMfaProof({ workosUserId: userId, sessionId: 'session_1' });
    const platformAdmin = await resolveIdentity();
    expect(platformAdmin).toMatchObject({ platformAdmin: true });

    mocks.cookieGet.mockImplementation((name: string) => (name === LEGACY_MFA_PROOF_COOKIE ? { value: proof } : undefined));
    await expect(requireGlobalMfa()).rejects.toBeInstanceOf(MfaRequiredError);
    await expect(requirePlatformStepUp(platformAdmin)).rejects.toBeInstanceOf(MfaRequiredError);

    mocks.cookieGet.mockImplementation((name: string) => (name === MFA_PROOF_COOKIE ? { value: proof } : undefined));
    await expect(requireGlobalMfa()).resolves.toMatchObject({ workosUserId: userId, sessionId: 'session_1' });
    await expect(requirePlatformStepUp(platformAdmin)).resolves.toBeUndefined();
  });

  it('selects the tenant (not platform) DB admin context for a reduced platform admin', async () => {
    cookie(`v1.${userId}.no-platform-admin`);
    const reduced = await resolveIdentity();
    await aiConfigRepo(reduced.tenant, reduced.user, repositoryActor(reduced)).listSharedReleases();
    const statements = mocks.txQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('app.is_platform_admin'))).toBe(false);
    expect(statements.some((sql) => sql.includes('app.platform_actor_workos_user_id'))).toBe(false);
    expect(statements.some((sql) => sql.includes("role='admin'"))).toBe(true);

    mocks.txQuery.mockClear();
    cookie(undefined);
    const real = await resolveIdentity();
    await aiConfigRepo(real.tenant, real.user, repositoryActor(real)).listSharedReleases();
    expect(mocks.txQuery.mock.calls.some(([sql]) => String(sql).includes('app.is_platform_admin'))).toBe(true);
  });

  it('refuses tenant-admin repository access for a reduced tenant admin before querying', async () => {
    cookie(`v1.${userId}.tenant-member+no-platform-admin`);
    const reduced = await resolveIdentity();
    expect(reduced).toMatchObject({ tenantRole: 'member', platformAdmin: false });
    await expect(aiConfigRepo(reduced.tenant, reduced.user, repositoryActor(reduced)).listSharedReleases()).rejects.toThrow('No tienes permisos para administrar la configuración.');
    expect(mocks.txQuery).not.toHaveBeenCalled();
  });

  it.each([
    'garbage',
    `v1.${userId}.tenant-admin`,
    `v1.${userId}.platform-admin`,
    `v1.${userId}.no-platform-admin+tenant-member`,
    `v1.${userId}.tenant-member+tenant-member`,
    `v2.${userId}.tenant-member`,
    `v1.user_someoneelse.tenant-member`,
    `v1.${userId}.`,
    '',
  ])('ignores a malformed or foreign cookie: %s', async (value) => {
    cookie(value);
    const identity = await resolveIdentity();
    expect(identity).toMatchObject({ tenantRole: 'admin', platformAdmin: true });
    expect(identity.reducedFrom).toBeUndefined();
  });

  it('cannot elevate a member through the cookie: reductions on missing roles are no-ops', async () => {
    mocks.resolveMember.mockResolvedValue({ userId: localUserId, role: 'member' });
    mocks.isSuperadmin.mockResolvedValue(false);
    cookie(`v1.${userId}.tenant-member+no-platform-admin`);
    const identity = await resolveIdentity();
    expect(identity).toMatchObject({ tenantRole: 'member', platformAdmin: false });
    expect(identity.reducedFrom).toBeUndefined();
  });

  it('reports panel state with real and effective roles only when the flag is on', async () => {
    cookie(`v1.${userId}.tenant-member`);
    await expect(getRoleSwitcherState()).resolves.toEqual({
      real: { tenantRole: 'admin', platformAdmin: true },
      effective: { tenantRole: 'member', platformAdmin: true },
      reduced: true,
    });
    mocks.resolveMember.mockResolvedValue({ userId: localUserId, role: 'member' });
    mocks.isSuperadmin.mockResolvedValue(false);
    await expect(getRoleSwitcherState()).resolves.toBeNull();
  });
});
