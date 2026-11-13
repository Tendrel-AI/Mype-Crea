import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn<() => Promise<any>>(),
  listByBrand: vi.fn<() => Promise<any[]>>(),
  getProduct: vi.fn<() => Promise<any>>(),
}));
vi.mock('../../repos', () => ({
  repos: () => ({
    conversations: { context: mocks.context },
    brandFiles: { listByBrand: mocks.listByBrand },
    products: { get: mocks.getProduct },
  }),
}));

import { productPhotosOfConversation, socialTaskInputs } from '../ad-task-inputs';

const CONVERSATION = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f' as never;
const tenant = { id: 't' as never };
const user = { id: 'u' as never };
const file = (over: Record<string, unknown>) => ({ id: 'f1', productId: 'p', kind: 'asset', contentType: 'image/png', storageKey: 'k1', originalName: 'a.png', ...over });

describe('socialTaskInputs (recorded in requirements_snapshot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ brandId: 'b', productId: 'p' });
    mocks.getProduct.mockResolvedValue({ attributes: { package_type: 'botella', price_pen: 5, ignored: 'x' } });
    mocks.listByBrand.mockResolvedValue([
      file({}),
      file({ id: 'f2', productId: 'other' }),
      file({ id: 'f3', kind: 'lab_report', contentType: 'application/pdf' }),
      file({ id: 'f4', kind: 'logo' }),
      file({ id: 'f5', contentType: 'application/pdf' }),
    ]);
  });

  it('adds the product facts and only this product image assets for the social-agent', async () => {
    expect(await socialTaskInputs(tenant, user)(CONVERSATION, 'social-agent')).toEqual({
      product_facts: { package_type: 'botella', price_pen: 5 },
      product_photos: [{ fileId: 'f1', storageKey: 'k1', contentType: 'image/png', originalName: 'a.png' }],
    });
  });

  it('adds nothing for other agents (and reads nothing)', async () => {
    expect(await socialTaskInputs(tenant, user)(CONVERSATION, 'label-agent')).toEqual({});
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it('adds nothing without a product, and productPhotosOfConversation is null there', async () => {
    mocks.context.mockResolvedValue({ brandId: 'b', productId: null });
    expect(await socialTaskInputs(tenant, user)(CONVERSATION, 'social-agent')).toEqual({});
    expect(await productPhotosOfConversation(tenant, user, CONVERSATION)).toBeNull();
  });
});
