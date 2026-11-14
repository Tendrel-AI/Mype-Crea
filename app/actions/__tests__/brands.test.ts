import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' }, tenantRole: 'member' };
  class TenantAdminRequiredError extends Error { constructor(readonly identity: unknown) { super('not admin'); } }
  return {
    identity,
    TenantAdminRequiredError,
    resolveIdentity: vi.fn(async () => identity),
    requireTenantAdmin: vi.fn(),
    archive: vi.fn(async () => true),
    productCreate: vi.fn(),
    productUpdate: vi.fn(),
    productGet: vi.fn(),
    brandUpdate: vi.fn(),
    brandGet: vi.fn(),
    listFiles: vi.fn(async () => []),
    listByBrand: vi.fn(async () => []),
    createOwnedBrand: vi.fn(),
    createOwnedProduct: vi.fn(),
  };
});

vi.mock('../../../src/auth/resolve-identity', () => ({
  resolveIdentity: mocks.resolveIdentity,
  requireTenantAdmin: mocks.requireTenantAdmin,
  TenantAdminRequiredError: mocks.TenantAdminRequiredError,
}));
vi.mock('../../../src/repos', () => ({
  repos: () => ({
    brands: { archive: mocks.archive, update: mocks.brandUpdate, get: mocks.brandGet },
    products: { create: mocks.productCreate, listByBrand: mocks.listByBrand, update: mocks.productUpdate, get: mocks.productGet },
    brandFiles: { listByBrand: mocks.listFiles },
  }),
}));
vi.mock('../../../src/conversations/selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/conversations/selection')>()),
  createOwnedBrand: mocks.createOwnedBrand,
  createOwnedProduct: mocks.createOwnedProduct,
  listOwnedBrands: vi.fn(async () => []),
}));

import {
  archiveBrandAction,
  createBrandAction,
  createProductAction,
  getBrandAction,
  getProductAction,
  updateBrandAction,
  updateProductAction,
} from '../brands';

const BRAND = '99999999-9999-4999-8999-999999999999';

const VALID_BRAND = { business_name: 'Café', business_category: 'Café', market_proposition: 'a', target_audience: 'b' };
const PRODUCT = '88888888-8888-4888-8888-888888888888';

describe('create actions (KAN-87)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createBrandAction delegates with the import flag and answers a failure safely', async () => {
    mocks.createOwnedBrand.mockResolvedValueOnce({ ok: true, conversationId: 'c', brandId: BRAND });
    await createBrandAction({ attributes: VALID_BRAND, imported: true });
    expect(mocks.createOwnedBrand).toHaveBeenCalledWith(mocks.identity, { attributes: VALID_BRAND, imported: true });
    mocks.createOwnedBrand.mockRejectedValueOnce(new Error('db down'));
    expect(await createBrandAction({ attributes: VALID_BRAND })).toMatchObject({ ok: false, code: 'configuration_unavailable' });
  });

  it('createProductAction answers a foreign brand like a malformed id (same not-found)', async () => {
    mocks.createOwnedProduct.mockResolvedValueOnce({ ok: false, code: 'brand_not_found', message: 'No encontramos esta marca.' });
    const foreign = await createProductAction({ brandId: BRAND, attributes: {} });
    const malformed = await createProductAction({ brandId: 'nope', attributes: {} });
    expect(foreign).toEqual(malformed);
    expect(foreign).toMatchObject({ ok: false, code: 'brand_not_found' });
  });
});

describe('update actions (KAN-87 edit validation)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updateBrandAction: an invalid patch returns per-field errors and never reaches the repo', async () => {
    const result = await updateBrandAction({ brandId: BRAND, attributes: { business_category: '', evil: 'x' } });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input', fieldErrors: { business_category: expect.any(String), evil: expect.any(String) } });
    expect(mocks.brandUpdate).not.toHaveBeenCalled();
  });

  it('updateBrandAction: passes the validated patch; the repo verdict on the merged object is surfaced as field errors', async () => {
    mocks.brandUpdate.mockResolvedValueOnce({ ok: true, name: 'Nuevo' });
    expect(await updateBrandAction({ brandId: BRAND, attributes: { business_name: 'Nuevo', imported: false } })).toEqual({ ok: true, name: 'Nuevo' });
    expect(mocks.brandUpdate).toHaveBeenCalledWith(BRAND, { ok: true, values: { business_name: 'Nuevo' }, cleared: [] });
    mocks.brandUpdate.mockResolvedValueOnce({ ok: false, code: 'invalid_input', errors: { market_proposition: 'Completa «Propuesta de mercado».' } });
    expect(await updateBrandAction({ brandId: BRAND, attributes: { location: 'Lima' } })).toMatchObject({ ok: false, code: 'invalid_input', fieldErrors: { market_proposition: expect.any(String) } });
  });

  it('updateBrandAction / updateProductAction answer a foreign, archived or malformed id with the same not-found', async () => {
    mocks.brandUpdate.mockResolvedValueOnce({ ok: false, code: 'brand_not_found' });
    const foreign = await updateBrandAction({ brandId: BRAND, attributes: { location: 'Lima' } });
    expect(foreign).toEqual(await updateBrandAction({ brandId: 'nope', attributes: {} }));
    mocks.productUpdate.mockResolvedValueOnce({ ok: false, code: 'product_not_found' });
    expect(await updateProductAction({ productId: PRODUCT, attributes: { product_name: 'X' } })).toMatchObject({ ok: false, code: 'product_not_found' });
    expect(await updateProductAction({ productId: 'nope', attributes: {} })).toMatchObject({ ok: false, code: 'product_not_found' });
  });

  it('getBrandAction / getProductAction return only the owner\'s data and files (foreign = not found)', async () => {
    mocks.brandGet.mockResolvedValueOnce(null);
    expect(await getBrandAction({ brandId: BRAND })).toMatchObject({ ok: false, code: 'brand_not_found' });
    mocks.productGet.mockResolvedValueOnce(null);
    expect(await getProductAction({ productId: PRODUCT })).toMatchObject({ ok: false, code: 'product_not_found' });
    mocks.productGet.mockResolvedValueOnce({ id: PRODUCT, brandId: BRAND, attributes: { product_name: 'X' } });
    mocks.brandGet.mockResolvedValueOnce({ id: BRAND, attributes: { business_name: 'Café' } });
    expect(await getProductAction({ productId: PRODUCT })).toMatchObject({ ok: true, brandAttributes: { business_name: 'Café' }, files: [] });
  });
});

describe('archiveBrandAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('archives an owned brand and gives not-found for foreign, archived or malformed ones', async () => {
    expect(await archiveBrandAction({ brandId: BRAND })).toEqual({ ok: true });
    mocks.archive.mockResolvedValueOnce(false);
    const foreign = await archiveBrandAction({ brandId: BRAND });
    expect(foreign).toEqual(await archiveBrandAction({ brandId: 'nope' }));
    expect(foreign).toMatchObject({ ok: false, code: 'brand_not_found' });
  });
});
