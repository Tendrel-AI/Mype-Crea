/** KAN-111: a brand's and product's chat id comes from the brand/product rows, not from the capped recent list. */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  brands: [{ id: 'b1', name: 'Café Andino', chatConversationId: 'old-brand-chat' }, { id: 'b2', name: null }],
  products: [{ id: 'p1', brandId: 'b1', name: 'Café molido', chatConversationId: 'old-product-chat' }],
}));
vi.mock('../../auth/resolve-identity', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../core/orchestrator/runtime', () => ({ getOrchestrator: vi.fn() }));
vi.mock('../../core/orchestrator/bootstrap-registry', () => ({ buildDefaultRegistry: () => ({ getFieldSchemas: () => [] }) }));
vi.mock('../../repos', () => ({
  repos: () => ({ brands: { listActive: async () => mocks.brands }, products: { listActive: async () => mocks.products } }),
}));

import { listOwnedBrands } from '../selection';

describe('listOwnedBrands chat ids (KAN-111)', () => {
  it('carries the pinned chat of each brand and product, null when there is none', async () => {
    const brands = await listOwnedBrands({ tenant: { id: 't' }, user: { id: 'u' } } as never);
    expect(brands).toEqual([
      { brandId: 'b1', name: 'Café Andino', chatConversationId: 'old-brand-chat', products: [{ productId: 'p1', name: 'Café molido', chatConversationId: 'old-product-chat' }] },
      { brandId: 'b2', name: null, chatConversationId: null, products: [] },
    ]);
  });
});
