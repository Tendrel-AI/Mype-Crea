/** KAN-104 controllers: MFA is required first, input is validated, and the actor comes from the session. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mfa: vi.fn(), set: vi.fn(), promote: vi.fn() }));
vi.mock('../../../src/auth/resolve-identity', () => ({ requireGlobalMfa: mocks.mfa }));
vi.mock('../../../src/repos/global', () => ({
  globalRepos: () => ({ limitDefaults: { set: mocks.set, list: vi.fn() }, dictionaries: { promote: mocks.promote } }),
}));
vi.mock('../../../src/core/limits/runtime', () => ({
  getLimitCatalog: () => [{ key: 'turns.per_conversation', label: 'x', default: 40 }],
}));

import { setPlatformLimitDefault } from '../platform-limits';
import { promoteOtroText } from '../platform-dictionaries';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mfa.mockResolvedValue({ workosUserId: 'user_A' });
});

describe('setPlatformLimitDefault', () => {
  it('refuses without MFA before touching the repo', async () => {
    mocks.mfa.mockRejectedValue(new Error('mfa'));
    await expect(setPlatformLimitDefault({ limitKey: 'turns.per_conversation', value: 5, reason: 'r' })).rejects.toThrow('mfa');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([[-1], [1001], [1.5]])('rejects out-of-range value %s and unknown keys', async (value) => {
    await expect(setPlatformLimitDefault({ limitKey: 'turns.per_conversation', value, reason: 'r' })).rejects.toThrow();
    await expect(setPlatformLimitDefault({ limitKey: 'nope.key', value: 5, reason: 'r' })).rejects.toThrow();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('writes with the session actor', async () => {
    await setPlatformLimitDefault({ limitKey: 'turns.per_conversation', value: 5, reason: ' r ' });
    expect(mocks.set).toHaveBeenCalledWith({ limitKey: 'turns.per_conversation', value: 5, reason: 'r', actorWorkosUserId: 'user_A' });
  });
});

describe('promoteOtroText', () => {
  it('refuses without MFA', async () => {
    mocks.mfa.mockRejectedValue(new Error('mfa'));
    await expect(promoteOtroText({ dictionaryKey: 'business_category', text: 'perros', categoryCode: 'TECNOLOGIA' })).rejects.toThrow('mfa');
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it('rejects OTRO, unknown codes and unknown dictionaries', async () => {
    for (const [dictionaryKey, categoryCode] of [['business_category', 'OTRO'], ['business_category', 'NADA'], ['nope', 'X']]) {
      await expect(promoteOtroText({ dictionaryKey, text: 'perros', categoryCode })).rejects.toThrow();
    }
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it('promotes to an existing code using its label', async () => {
    const { DICTIONARIES } = await import('../../../src/core/dictionaries');
    const entry = DICTIONARIES.business_category.entries[0];
    mocks.promote.mockResolvedValue({ category: entry.code, rowsRemapped: 2 });
    await promoteOtroText({ dictionaryKey: 'business_category', text: 'perros', categoryCode: entry.code });
    expect(mocks.promote).toHaveBeenCalledWith({ dictionaryKey: 'business_category', label: entry.label, texts: ['perros'] }, 'user_A');
  });
});
