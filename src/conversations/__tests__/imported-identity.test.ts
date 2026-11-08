import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adoptOwnVersion: vi.fn(),
  startConversation: vi.fn(),
  findBrandConversation: vi.fn(),
}));
vi.mock('../../core/orchestrator/runtime', () => ({
  getOrchestrator: () => ({ adoptOwnVersion: mocks.adoptOwnVersion, startConversation: mocks.startConversation }),
}));
vi.mock('../../repos', () => ({ repos: () => ({ ownCandidates: { findBrandConversation: mocks.findBrandConversation } }) }));

import { adoptImportedBrand, adoptImportedLogo } from '../imported-identity';

const identity = { tenant: { id: 't' }, user: { id: 'u' } } as never;
const CONV = 'c1' as never;

describe('imported brand identity (KAN-89)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adoptOwnVersion.mockResolvedValue(true);
  });

  it('adopts the name and the given tagline through the command path', async () => {
    await adoptImportedBrand(identity, CONV, { business_name: 'Sol', existing_tagline: 'Pan de casa' });
    expect(mocks.adoptOwnVersion.mock.calls).toEqual([[CONV, 'business_name', 'Sol'], [CONV, 'tagline', 'Pan de casa']]);
  });

  it('skips a pending name and an empty tagline', async () => {
    await adoptImportedBrand(identity, CONV, { business_name: 'Sol', name_pending: true, existing_tagline: ' ' });
    expect(mocks.adoptOwnVersion).not.toHaveBeenCalled();
  });

  it('a failing item does not stop the next one nor throw', async () => {
    mocks.adoptOwnVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(adoptImportedBrand(identity, CONV, { business_name: 'Sol', existing_tagline: 'x' })).resolves.toBeUndefined();
    expect(mocks.adoptOwnVersion).toHaveBeenCalledTimes(2);
  });

  it('adopts the uploaded logo only for imported brands', async () => {
    mocks.findBrandConversation.mockResolvedValue(CONV);
    await adoptImportedLogo(identity, { id: 'b' as never, attributes: {} });
    expect(mocks.adoptOwnVersion).not.toHaveBeenCalled();
    await adoptImportedLogo(identity, { id: 'b' as never, attributes: { imported: true } });
    expect(mocks.adoptOwnVersion).toHaveBeenCalledWith(CONV, 'logo', undefined);
  });
});
