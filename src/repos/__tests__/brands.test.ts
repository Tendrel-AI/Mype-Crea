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
import { NotTenantAdminError } from '../tenant-accounts';

const TENANT = { id: 'tenant-a' };
const USER = { id: 'user-a' };
const BRAND = '99999999-9999-4999-8999-999999999999';

interface Fake { brands: Array<{ id: string; status: 'active' | 'archived' }>; conversations: number; limits: { b: number; c: number }; isAdmin: boolean }

/** A tiny stateful stand-in for Postgres: the SQL shape decides the answer. */
function fakeDb(state: Fake) {
  mocked.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM tenants')) return { rows: [{ max_brands_per_user: state.limits.b, max_conversations_per_brand: state.limits.c }] };
    if (sql.includes('FROM brands WHERE tenant_id')) {
      return { rows: [{ n: state.brands.filter((b) => !sql.includes(`status = 'active'`) || b.status === 'active').length }] };
    }
    if (sql.includes('INSERT INTO brands')) { state.brands.push({ id: 'new-brand', status: 'active' }); return { rows: [{ id: 'new-brand' }] }; }
    if (sql.includes('FOR UPDATE')) {
      return { rows: state.brands.some((b) => b.id === BRAND && b.status === 'active') ? [{ id: BRAND }] : [] };
    }
    if (sql.includes('FROM conversations')) return { rows: [{ n: state.conversations }] };
    if (sql.includes('app.has_tenant_admin')) return { rows: [{ ok: state.isAdmin }] };
    if (sql.includes('app.set_brand_limits')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
}

const inserted = () => mocked.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO brands'));
const repo = () => brandsRepo(TENANT, USER);

describe('brandsRepo.create (brand limit)', () => {
  beforeEach(() => { mocked.query.mockReset(); mocked.pin.mockClear(); });

  it('creates a brand under the limit, taking the per-user advisory lock before counting', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'active' }], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: true, brandId: 'new-brand' });
    const sqls = mocked.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toContain("pg_advisory_xact_lock(hashtext('brands:'");
    expect(sqls.findIndex((s) => s.includes('count(*)'))).toBeGreaterThan(0);
  });

  it('returns a typed refusal at the limit and inserts nothing', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'active' }, { id: 'b2', status: 'active' }, { id: 'b3', status: 'active' }], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: false, code: 'brand_limit_reached', limit: 3 });
    expect(inserted()).toBe(false);
  });

  it('does not count archived brands', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'archived' }, { id: 'b2', status: 'archived' }, { id: 'b3', status: 'active' }], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    expect(await repo().create({})).toMatchObject({ ok: true });
  });

  it('a limit lowered below the current count blocks only new brands and deletes nothing', async () => {
    fakeDb({ brands: [{ id: 'b1', status: 'active' }, { id: 'b2', status: 'active' }, { id: 'b3', status: 'active' }], conversations: 0, limits: { b: 1, c: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: false, code: 'brand_limit_reached', limit: 1 });
    expect(mocked.query.mock.calls.some(([sql]) => /DELETE|UPDATE/.test(String(sql)))).toBe(false);
  });

  it('pins the first conversation in the same transaction, under the new brand', async () => {
    fakeDb({ brands: [], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    const result = await repo().create({ firstConversation: { conversationId: 'c-1' as never, schemas: [] } });
    expect(result).toMatchObject({ ok: true, brandId: 'new-brand' });
    expect(mocked.pin).toHaveBeenCalledWith(expect.anything(), TENANT, USER, expect.objectContaining({ conversationId: 'c-1' }), 'new-brand');
  });

  it('a limit of 0 refuses every creation', async () => {
    fakeDb({ brands: [], conversations: 0, limits: { b: 0, c: 5 }, isAdmin: false });
    expect(await repo().create({})).toEqual({ ok: false, code: 'brand_limit_reached', limit: 0 });
  });
});

describe('brandsRepo.createConversation (per-brand limit)', () => {
  beforeEach(() => { mocked.query.mockReset(); mocked.pin.mockClear(); });
  const input = { brandId: BRAND as never, conversationId: 'c-1' as never, schemas: [] };

  it('locks the active owned brand, then pins within the limit', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], conversations: 4, limits: { b: 3, c: 5 }, isAdmin: false });
    expect(await repo().createConversation(input)).toMatchObject({ ok: true });
    expect(mocked.pin).toHaveBeenCalledWith(expect.anything(), TENANT, USER, expect.anything(), BRAND);
    const lock = mocked.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('FOR UPDATE'))!;
    expect(lock).toContain("status = 'active'");
    expect(lock).toContain('user_id = $3');
  });

  it('refuses at the limit with a typed result', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'active' }], conversations: 5, limits: { b: 3, c: 5 }, isAdmin: false });
    expect(await repo().createConversation(input)).toEqual({ ok: false, code: 'conversation_limit_reached', limit: 5 });
    expect(mocked.pin).not.toHaveBeenCalled();
  });

  it('refuses a foreign or missing brand and an archived one the same way', async () => {
    fakeDb({ brands: [{ id: BRAND, status: 'archived' }], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    const archived = await repo().createConversation(input);
    fakeDb({ brands: [], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    const missing = await repo().createConversation(input);
    expect(archived).toEqual({ ok: false, code: 'brand_not_found' });
    expect(missing).toEqual(archived);
    expect(mocked.pin).not.toHaveBeenCalled();
  });
});

describe('brandsRepo.setLimits', () => {
  beforeEach(() => { mocked.query.mockReset(); });

  it('refuses a member without touching the limits', async () => {
    fakeDb({ brands: [], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: false });
    await expect(repo().setLimits({ maxBrandsPerUser: 9, maxConversationsPerBrand: 9 })).rejects.toBeInstanceOf(NotTenantAdminError);
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes('set_brand_limits'))).toBe(false);
  });

  it('lets an admin save through the definer helper', async () => {
    fakeDb({ brands: [], conversations: 0, limits: { b: 3, c: 5 }, isAdmin: true });
    await repo().setLimits({ maxBrandsPerUser: 9, maxConversationsPerBrand: 8 });
    expect(mocked.query).toHaveBeenLastCalledWith('SELECT app.set_brand_limits($1, $2)', [9, 8]);
  });
});

describe('productsRepo.create', () => {
  beforeEach(() => { mocked.query.mockReset(); });

  it('refuses a foreign, missing or archived brand (the guarded INSERT returns no row)', async () => {
    mocked.query.mockResolvedValue({ rows: [] });
    expect(await productsRepo(TENANT, USER).create({ brandId: BRAND as never })).toEqual({ ok: false, code: 'brand_not_found' });
    const [sql, params] = mocked.query.mock.calls[0];
    expect(String(sql)).toContain("b.user_id = $3 AND b.status = 'active'");
    expect(params.slice(0, 3)).toEqual([BRAND, 'tenant-a', 'user-a']);
  });

  it('creates a product on an owned active brand', async () => {
    mocked.query.mockResolvedValue({ rows: [{ id: 'p1', brand_id: BRAND, name: 'Café', attributes: {}, created_at: new Date('2026-01-01T00:00:00Z') }] });
    expect(await productsRepo(TENANT, USER).create({ brandId: BRAND as never, name: 'Café' })).toMatchObject({ ok: true, product: { id: 'p1', brandId: BRAND } });
  });
});
