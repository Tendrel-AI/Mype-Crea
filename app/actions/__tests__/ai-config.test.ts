import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  requirePlatformStepUp: vi.fn(),
  repos: vi.fn(),
}));

vi.mock('../../../src/auth/resolve-identity', () => ({
  resolveIdentity: mocks.resolveIdentity,
  requirePlatformStepUp: mocks.requirePlatformStepUp,
  repositoryActor: (identity: { workosUserId: string; platformAdmin: boolean; tenantRole: string }) => ({
    workosUserId: identity.workosUserId, platformAdmin: identity.platformAdmin, tenantRole: identity.tenantRole,
  }),
}));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/services/ai-config/service', () => ({
  AiConfigService: class {
    listReleases = async () => [];
    listSharedReleases = async () => [];
    listProviderAvailability = async () => [];
    listSyncEvents = async () => [];
  },
}));
vi.mock('../../../src/services/ai-config/admin-service', () => ({
  AiAdminService: class {
    getUsage = async () => null;
    listTurns = async () => [];
  },
}));
vi.mock('../../../src/services/ai-config/provider-registry', () => ({
  ProviderRegistry: class { isPlatformAvailable = () => true; },
}));

import { MfaRequiredError } from '../../../src/auth/platform-mfa';
import { activateAiConfigRelease, getAiConfigAdminData, getAiTurnTrace } from '../ai-config';

describe('AI configuration server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveIdentity.mockResolvedValue({
      tenant: { id: 'tenant-a' },
      user: { id: 'user-member' },
      tenantRole: 'member',
      workosUserId: 'workos_member',
      organizationId: 'org-a',
      platformAdmin: false,
    });
  });

  it('re-resolves identity and rejects forged tenant trace IDs for members', async () => {
    const result = await getAiTurnTrace('00000000-0000-4000-8000-000000000001');
    expect(mocks.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(mocks.repos).not.toHaveBeenCalled();
  });

  it('rejects forged activation parameters for members before repository access', async () => {
    const result = await activateAiConfigRelease({
      releaseId: '00000000-0000-4000-8000-000000000002',
      expectedActivationVersion: 0,
    });
    expect(mocks.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(mocks.repos).not.toHaveBeenCalled();
  });

  it('requires the platform step-up (current MFA proof) before AI administration actions', async () => {
    const platformIdentity = {
      tenant: { id: 'tenant-a' },
      user: { id: 'user-admin' },
      tenantRole: 'member',
      workosUserId: 'user_global',
      organizationId: 'org-a',
      platformAdmin: true,
    };
    mocks.resolveIdentity.mockResolvedValueOnce(platformIdentity);
    mocks.requirePlatformStepUp.mockRejectedValueOnce(new Error('MFA required'));

    const result = await getAiTurnTrace('00000000-0000-4000-8000-000000000002');
    expect(result.ok).toBe(false);
    expect(mocks.requirePlatformStepUp).toHaveBeenCalledWith(platformIdentity);
    expect(mocks.repos).not.toHaveBeenCalled();
  });

  it('still requires the step-up for a real platform admin acting with reduced roles (KAN-79)', async () => {
    const reduced = {
      tenant: { id: 'tenant-a' },
      user: { id: 'user-admin' },
      tenantRole: 'admin',
      workosUserId: 'user_global',
      organizationId: 'org-a',
      platformAdmin: false,
      reducedFrom: { tenantRole: 'admin', platformAdmin: true },
    };
    mocks.resolveIdentity.mockResolvedValueOnce(reduced);
    mocks.requirePlatformStepUp.mockRejectedValueOnce(new Error('MFA required'));

    const result = await activateAiConfigRelease({ releaseId: '00000000-0000-4000-8000-000000000002', expectedActivationVersion: 0 });
    expect(result.ok).toBe(false);
    expect(mocks.requirePlatformStepUp).toHaveBeenCalledWith(reduced);
    expect(mocks.repos).not.toHaveBeenCalled();
  });

  describe('admin page data without a platform MFA proof (KAN-80)', () => {
    const platformAdmin = {
      tenant: { id: 'tenant-a' },
      user: { id: 'user-admin' },
      tenantRole: 'admin',
      workosUserId: 'user_global',
      organizationId: 'org-a',
      platformAdmin: true,
    };

    it('reports mfa_required to the page for a platform admin, without touching repositories', async () => {
      mocks.resolveIdentity.mockResolvedValueOnce(platformAdmin);
      mocks.requirePlatformStepUp.mockRejectedValueOnce(new MfaRequiredError());

      const result = await getAiConfigAdminData();
      expect(result).toEqual({ ok: false, reason: 'mfa_required', error: 'Verifica tu código de autenticación de la plataforma para continuar.' });
      expect(mocks.repos).not.toHaveBeenCalled();
    });

    it('keeps the generic failure when the step-up fails for any other reason', async () => {
      mocks.resolveIdentity.mockResolvedValueOnce(platformAdmin);
      mocks.requirePlatformStepUp.mockRejectedValueOnce(new Error('No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.'));

      const result = await getAiConfigAdminData();
      expect(result.ok).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('does not treat a reduced platform admin as one: generic failure, no mfa_required (KAN-79)', async () => {
      const reduced = { ...platformAdmin, platformAdmin: false, reducedFrom: { tenantRole: 'admin', platformAdmin: true } };
      mocks.resolveIdentity.mockResolvedValueOnce(reduced);
      mocks.requirePlatformStepUp.mockRejectedValueOnce(new MfaRequiredError());

      const result = await getAiConfigAdminData();
      expect(mocks.requirePlatformStepUp).toHaveBeenCalledWith(reduced);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(mocks.repos).not.toHaveBeenCalled();
    });

    it('leaves a tenant admin without the platform role unaffected', async () => {
      const tenantAdmin = { ...platformAdmin, workosUserId: 'user_tenant_admin', platformAdmin: false };
      mocks.resolveIdentity.mockResolvedValueOnce(tenantAdmin);
      mocks.requirePlatformStepUp.mockResolvedValueOnce(undefined);
      mocks.repos.mockReturnValue({ aiConfig: { getActivation: async () => null } });

      const result = await getAiConfigAdminData();
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.data).toMatchObject({ tenantId: 'tenant-a', tenantRole: 'admin', platformAdmin: false });
    });
  });
});
