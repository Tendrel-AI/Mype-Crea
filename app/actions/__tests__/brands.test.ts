import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' }, tenantRole: 'member' };
  class TenantAdminRequiredError extends Error { constructor(readonly identity: unknown) { super('not admin'); } }
  return {
    identity,
    TenantAdminRequiredError,
    resolveIdentity: vi.fn(async () => identity),
    requireTenantAdmin: vi.fn(),
    setLimits: vi.fn(async () => undefined),
    getLimits: vi.fn(async () => ({ maxBrandsPerUser: 3, maxConversationsPerBrand: 5 })),
    archive: vi.fn(async () => true),
    productCreate: vi.fn(),
    listByBrand: vi.fn(async () => []),
  };
});

vi.mock('../../../src/auth/resolve-identity', () => ({
  resolveIdentity: mocks.resolveIdentity,
  requireTenantAdmin: mocks.requireTenantAdmin,
  TenantAdminRequiredError: mocks.TenantAdminRequiredError,
}));
vi.mock('../../../src/repos', () => ({
  repos: () => ({
    brands: { setLimits: mocks.setLimits, getLimits: mocks.getLimits, archive: mocks.archive },
    products: { create: mocks.productCreate, listByBrand: mocks.listByBrand },
  }),
}));
vi.mock('../../../src/conversations/selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/conversations/selection')>()),
  createOwnedBrand: vi.fn(),
  listOwnedBrands: vi.fn(async () => []),
}));

import { NotTenantAdminError } from '../../../src/repos/tenant-accounts';
import {
  archiveBrandAction,
  createProductAction,
  getBrandLimitsAction,
  updateBrandLimitsAction,
} from '../brands';

const BRAND = '99999999-9999-4999-8999-999999999999';
const ADMIN = { ...mocks.identity, tenantRole: 'admin' };

describe('updateBrandLimitsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireTenantAdmin.mockResolvedValue(ADMIN);
  });

  it('refuses a member before touching any repo', async () => {
    mocks.requireTenantAdmin.mockRejectedValueOnce(new mocks.TenantAdminRequiredError(mocks.identity));
    const result = await updateBrandLimitsAction({ maxBrandsPerUser: 9, maxConversationsPerBrand: 9 });
    expect(result).toMatchObject({ ok: false, code: 'not_admin' });
    expect(mocks.setLimits).not.toHaveBeenCalled();
  });

  it('refuses when the database says the user is not an active admin', async () => {
    mocks.setLimits.mockRejectedValueOnce(new NotTenantAdminError());
    expect(await updateBrandLimitsAction({ maxBrandsPerUser: 9, maxConversationsPerBrand: 9 })).toMatchObject({ ok: false, code: 'not_admin' });
  });

  it('saves for an admin', async () => {
    expect(await updateBrandLimitsAction({ maxBrandsPerUser: 4, maxConversationsPerBrand: 0 }))
      .toEqual({ ok: true, maxBrandsPerUser: 4, maxConversationsPerBrand: 0 });
    expect(mocks.setLimits).toHaveBeenCalledWith({ maxBrandsPerUser: 4, maxConversationsPerBrand: 0 });
  });

  it.each([[-1, 5], [1001, 5], [1.5, 5], [5, Number.NaN], ['3' as never, 5]])('rejects invalid values %j / %j', async (brands, conversations) => {
    const result = await updateBrandLimitsAction({ maxBrandsPerUser: brands, maxConversationsPerBrand: conversations });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(mocks.setLimits).not.toHaveBeenCalled();
  });
});

describe('getBrandLimitsAction', () => {
  it('returns the tenant limits', async () => {
    expect(await getBrandLimitsAction()).toEqual({ ok: true, maxBrandsPerUser: 3, maxConversationsPerBrand: 5 });
  });
});

describe('createProductAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers a foreign brand like a malformed id (same not-found)', async () => {
    mocks.productCreate.mockResolvedValueOnce({ ok: false, code: 'brand_not_found' });
    const foreign = await createProductAction({ brandId: BRAND, name: 'Café' });
    const malformed = await createProductAction({ brandId: 'nope' });
    expect(foreign).toEqual(malformed);
    expect(foreign).toMatchObject({ ok: false, code: 'brand_not_found' });
  });

  it.each([
    ['an array', [] as never],
    ['a class instance', new Date() as never],
    ['an oversized object', { blob: 'x'.repeat(17 * 1024) }],
  ])('rejects attributes that are %s', async (_label, attributes) => {
    expect(await createProductAction({ brandId: BRAND, attributes })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(mocks.productCreate).not.toHaveBeenCalled();
  });

  it('creates with plain attributes', async () => {
    const product = { id: 'p1', brandId: BRAND, name: 'Café', attributes: { size: 'L' }, createdAt: 'x' };
    mocks.productCreate.mockResolvedValueOnce({ ok: true, product });
    expect(await createProductAction({ brandId: BRAND, name: ' Café ', attributes: { size: 'L' } })).toEqual({ ok: true, product });
    expect(mocks.productCreate).toHaveBeenCalledWith({ brandId: BRAND, name: 'Café', attributes: { size: 'L' } });
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
