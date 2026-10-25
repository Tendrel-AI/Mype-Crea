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

import { activateAiConfigRelease, getAiTurnTrace } from '../ai-config';

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
});
