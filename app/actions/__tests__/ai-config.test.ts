import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveIdentity: vi.fn(),
  repos: vi.fn(),
}));

vi.mock('../../../src/auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
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
});
