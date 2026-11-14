import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn<() => Promise<any>>(),
  listByBrand: vi.fn<() => Promise<any[]>>(),
}));
vi.mock('../../repos', () => ({
  repos: () => ({
    conversations: { context: mocks.context },
    brandFiles: { listByBrand: mocks.listByBrand },
  }),
}));

import { logoReferencesOfConversation, logoTaskInputs } from '../logo-task-inputs';

const CONVERSATION = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f' as never;
const tenant = { id: 't' as never };
const user = { id: 'u' as never };
const file = (over: Record<string, unknown>) => ({ id: 'f1', productId: null, kind: 'logo_reference', contentType: 'image/png', storageKey: 'k1', originalName: 'a.png', ...over });

describe('logoTaskInputs (D62, recorded in requirements_snapshot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ brandId: 'b', productId: null });
    mocks.listByBrand.mockResolvedValue([file({}), file({ id: 'f2', kind: 'logo' }), file({ id: 'f3', kind: 'asset' })]);
  });

  it('adds only the brand logo references for the logo-agent', async () => {
    expect(await logoTaskInputs(tenant, user)(CONVERSATION, 'logo-agent')).toEqual({
      logo_references: [{ fileId: 'f1', storageKey: 'k1', contentType: 'image/png', originalName: 'a.png' }],
    });
  });

  it('adds nothing for other agents and reads nothing', async () => {
    expect(await logoTaskInputs(tenant, user)(CONVERSATION, 'name-agent')).toEqual({});
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it('a product chat has no references (even if the brand has some)', async () => {
    mocks.context.mockResolvedValue({ brandId: 'b', productId: 'p' });
    expect(await logoTaskInputs(tenant, user)(CONVERSATION, 'logo-agent')).toEqual({});
    expect(await logoReferencesOfConversation(tenant, user, CONVERSATION)).toBeNull();
  });

  it('adds nothing when the brand has no references', async () => {
    mocks.listByBrand.mockResolvedValue([file({ kind: 'logo' })]);
    expect(await logoTaskInputs(tenant, user)(CONVERSATION, 'logo-agent')).toEqual({});
  });
});
