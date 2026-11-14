import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  pin: vi.fn(async () => ({ state: 'pinned', releaseId: 'release-1' })),
}));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_t: unknown, _u: unknown, work: (tx: { query: typeof mocked.query }) => unknown) => work({ query: mocked.query }),
}));
vi.mock('../conversations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../conversations')>()),
  pinConversationInTx: mocked.pin,
}));

import { brandsRepo } from '../brands';
import { productsRepo } from '../products';

const TENANT = { id: 'tenant-a' };
const USER = { id: 'user-a' };
const BRAND = '99999999-9999-4999-8999-999999999999';

interface Fake {
  brands: Array<{ id: string; status: 'active' | 'archived' }>;
  products: number;
  limits: { b: number; p: number };
  isAdmin: boolean;
  /** Product ids that belong to BRAND. */
  ownedProducts?: string[];
  /** An active chat already exists for the brand/product (KAN-97). */
  existingChat?: boolean;
  attributes?: Record<string, unknown>;
}

/** A tiny stateful stand-in for Postgres: the SQL shape decides the answer. */
function fakeDb(state: Fake) {
  mocked.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('platform_limit_defaults')) return { rows: [{ limit_key: 'brands.per_user', value: state.limits.b }, { limit_key: 'products.per_brand', value: state.limits.p }] };
    if (sql.includes('FROM brands WHERE tenant_id')) {
      return { rows: [{ n: state.brands.filter((b) => !sql.includes(`status = 'active'`) || b.status === 'active').length }] };
    }
    if (sql.includes('INSERT INTO brands')) { state.brands.push({ id: 'new-brand', status: 'active' }); return { rows: [{ id: 'new-brand' }] }; }
    if (sql.includes('INSERT INTO products')) {
      return { rows: [{ id: 'new-product', brand_id: BRAND, name: params[3], attributes: {}, created_at: new Date('2026-01-01T00:00:00Z') }] };
    }
    if (sql.includes('FROM conversations')) return { rows: state.existingChat ? [{ '?column?': 1 }] : [] };
    if (sql.includes('FROM products WHERE id')) return { rows: state.ownedProducts?.includes(String(params[0])) ? [{ id: params[0] }] : [] };
    if (sql.includes('FROM products WHERE tenant_id')) return { rows: [{ n: state.products }] };
    if (sql.includes('FROM brands WHERE id')) {
      return { rows: state.brands.some((b) => b.id === BRAND && b.status === 'active') ? [{ id: BRAND, attributes: state.attributes ?? {} }] : [] };
    }
    if (sql.includes('UPDATE brands')) return { rows: [] };
    if (sql.includes('app.has_tenant_admin')) return { rows: [{ ok: state.isAdmin }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
}

const inserted = () => mocked.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO brands'));
const repo = () => brandsRepo(TENANT, USER);

describe('brandsRepo.create (brand limit)', () => {
  beforeEach(() => { mocked.query.mockReset(); mocked.pin.mockClear(); });

  it('creates a brand under the limit, taking the per-user advisory lock before counting', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: true, brandId: 'new-brand' });
    const sqls = mocked.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toContain("pg_advisory_xact_lock(hashtext('brands:'");
    expect(sqls.findIndex((s) => s.includes('count(*)'))).toBeGreaterThan(0);
  });

  it('returns a typed refusal at the limit and inserts nothing', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'active' }, { id: 'b2', status: 'active' }, { id: 'b3', status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: false, code: 'brand_limit_reached', limit: 3 });
    expect(inserted()).toBe(false);
  });

  it('does not count archived brands', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'archived' }, { id: 'b2', status: 'archived' }, { id: 'b3', status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await repo().create({})).toMatchObject({ ok: true });
  });

  it('a limit lowered below the current count blocks only new brands and deletes nothing', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'active' }, { id: 'b2', status: 'active' }, { id: 'b3', status: 'active' }], products: 0, limits: { b: 1, p: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: false, code: 'brand_limit_reached', limit: 1 });
    expect(mocked.query.mock.calls.some(([sql]) => /DELETE|UPDATE/.test(String(sql)))).toBe(false);
  });

  it('pins the first conversation in the same transaction, under the new brand', async () => {
    fakeDb({ brands: [], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    const result = await repo().create({ firstConversation: { conversationId: 'c-1' as never, schemas: [] } });
    expect(result).toMatchObject({ ok: true, brandId: 'new-brand' });
    expect(mocked.pin).toHaveBeenCalledWith(expect.anything(), TENANT, USER, expect.objectContaining({ conversationId: 'c-1' }), 'new-brand');
  });

  it('a limit of 0 refuses every creation', async () => {
    fakeDb({ brands: [], products: 0, limits: { b: 0, p: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: false, code: 'brand_limit_reached', limit: 0 });
  });
});

describe('brandsRepo.createConversation (no conversation limit, product consistency)', () => {
  beforeEach(() => { mocked.query.mockReset(); mocked.pin.mockClear(); });
  const input = { brandId: BRAND as never, conversationId: 'c-1' as never, schemas: [] };
  const PRODUCT = '88888888-8888-4888-8888-888888888888';

  it('locks the active owned brand and pins under it when it has no active chat yet', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await repo().createConversation(input)).toMatchObject({ ok: true });
    expect(mocked.pin).toHaveBeenCalledWith(expect.anything(), TENANT, USER, expect.anything(), BRAND, null);
    const lock = mocked.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('FOR SHARE'))!;
    expect(lock).toContain("status = 'active'");
    expect(lock).toContain('user_id = $3');
  });

  it('pins a product conversation only when the product belongs to that brand and owner', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false, ownedProducts: [PRODUCT] });
    expect(await repo().createConversation({ ...input, productId: PRODUCT as never })).toMatchObject({ ok: true });
    expect(mocked.pin).toHaveBeenCalledWith(expect.anything(), TENANT, USER, expect.anything(), BRAND, PRODUCT);
  });

  it('KAN-97: an existing active chat yields conversation_exists and pins nothing', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false, existingChat: true });
    expect(await repo().createConversation(input)).toEqual({ ok: false, code: 'conversation_exists' });
    expect(mocked.pin).not.toHaveBeenCalled();
  });

  it('refuses a product of another brand (or another user) and pins nothing', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false, ownedProducts: [] });
    expect(await repo().createConversation({ ...input, productId: PRODUCT as never })).toEqual({ ok: false, code: 'product_not_found' });
    expect(mocked.pin).not.toHaveBeenCalled();
    const check = mocked.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('FROM products WHERE id'))!;
    expect(check).toContain('brand_id = $3');
    expect(check).toContain('user_id = $4');
  });

  it('refuses a foreign or missing brand and an archived one the same way', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'archived' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    const archived = await repo().createConversation(input);
    fakeDb({ brands: [], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    const missing = await repo().createConversation(input);
    expect(archived).toEqual({ ok: false, code: 'brand_not_found' });
    expect(missing).toEqual(archived);
    expect(mocked.pin).not.toHaveBeenCalled();
  });
});

describe('brandsRepo.update (edit validation)', () => {
  beforeEach(() => { mocked.query.mockReset(); });
  const stored = { business_name: 'Café', business_category: 'Café', market_proposition: 'a', target_audience: 'b' };

  it('merges the patch and validates the merged object: clearing a required field is refused, nothing written', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false, attributes: stored });
    const result = await repo().update(BRAND as never, { values: {}, cleared: ['business_category'] });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input', errors: { business_category: expect.any(String) } });
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE brands'))).toBe(false);
  });

  it('writes the merged attributes and keeps the name column in step with business_name', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false, attributes: stored });
    expect(await repo().update(BRAND as never, { values: { business_name: 'Café Andino' }, cleared: [] })).toEqual({ ok: true, name: 'Café Andino' });
    const update = mocked.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE brands'))!;
    expect(update[1][3]).toBe('Café Andino');
    expect(JSON.parse(update[1][4])).toMatchObject({ business_name: 'Café Andino', business_category: 'Café' });
  });

  it('answers brand_not_found for a foreign, missing or archived brand', async () => {
    fakeDb({ brands: [], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await repo().update(BRAND as never, { values: {}, cleared: [] })).toEqual({ ok: false, code: 'brand_not_found' });
  });
});

describe('productsRepo.create (product limit)', () => {
  beforeEach(() => { mocked.query.mockReset(); mocked.pin.mockClear(); });
  const input = { brandId: BRAND as never, name: 'Café', attributes: { product_name: 'Café' } };

  it('locks the owner\'s active brand FOR UPDATE, counts its products, then inserts and pins under the product', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 4, limits: { b: 3, p: 5 }, isAdmin: false });
    const result = await productsRepo(TENANT, USER).create({ ...input, firstConversation: { conversationId: 'c-1' as never, schemas: [] } });
    expect(result).toMatchObject({ ok: true, product: { id: 'new-product', brandId: BRAND } });
    expect(mocked.pin).toHaveBeenCalledWith(expect.anything(), TENANT, USER, expect.anything(), BRAND, 'new-product');
    const sqls = mocked.query.mock.calls.map(([sql]) => String(sql));
    const lock = sqls.findIndex((sql) => sql.includes('FOR UPDATE'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(sqls[lock]).toContain("status = 'active'");
    expect(lock).toBeLessThan(sqls.findIndex((sql) => sql.includes('count(*)')));
  });

  it('returns the typed refusal at the limit and inserts nothing', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], products: 5, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await productsRepo(TENANT, USER).create(input)).toEqual({ ok: false, code: 'product_limit_reached', limit: 5 });
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO products'))).toBe(false);
    expect(mocked.pin).not.toHaveBeenCalled();
  });

  it('refuses a foreign, missing or archived brand', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'archived' }], products: 0, limits: { b: 3, p: 5 }, isAdmin: false });
    expect(await productsRepo(TENANT, USER).create(input)).toEqual({ ok: false, code: 'brand_not_found' });
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO products'))).toBe(false);
  });
});
