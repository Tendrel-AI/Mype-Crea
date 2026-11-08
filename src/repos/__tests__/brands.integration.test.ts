/**
 * KAN-85 brands, products and limits against a disposable PostgreSQL database (NOT run by the
 * agent that wrote it). Proves owner-only RLS across users and tenants, that two concurrent
 * `create()` calls at limit-1 admit exactly one, and that a plain member cannot change the limit
 * columns (no column grant, helper refuses non-admins). DATABASE_URL (owner) only seeds and
 * inspects; every product path runs as app_user. Refuses to run unless both URLs point at the
 * same database ending in _ci or _test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { withTenantTransaction } from '../../db/with-transaction';
import { repos, type Tenant, type User } from '..';
import { NotTenantAdminError } from '../tenant-accounts';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) throw new Error('Brand integration tests require one disposable database ending in _ci or _test');
  if (owner.hostname !== app.hostname || owner.port !== app.port) throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  if (owner.username === 'app_user' || app.username !== 'app_user') throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
}

SUITE('KAN-85 brands (integration)', () => {
  let owner: pg.Client;

  async function createTenant(): Promise<{ tenant: Tenant; admin: User; member: User; other: User }> {
    const tenantId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `KAN-85 ${tenantId}`]);
    const mk = async (role: 'admin' | 'member'): Promise<User> => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [id, tenantId, `kan85-${id}`, `${id}@example.invalid`, role],
      );
      return { id };
    };
    return { tenant: { id: tenantId }, admin: await mk('admin'), member: await mk('member'), other: await mk('member') };
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL!;
    assertDisposableTarget(ownerUrl, process.env.APP_DATABASE_URL!);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const who = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
  });

  afterAll(async () => {
    await owner?.end();
    await closePool();
  });

  it('defaults the limits to 3 brands per user and 5 conversations per brand', async () => {
    const { tenant, member } = await createTenant();
    expect(await repos(tenant, member).brands.getLimits()).toEqual({ maxBrandsPerUser: 3, maxConversationsPerBrand: 5 });
  });

  it('isolates brands and products across users and tenants', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const created = await repos(a.tenant, a.member).brands.create({ name: 'Café' });
    if (!created.ok) throw new Error('expected brand');
    const product = await repos(a.tenant, a.member).products.create({ brandId: created.brandId, name: 'Molido' });
    expect(product.ok).toBe(true);

    expect((await repos(a.tenant, a.member).brands.listActive()).map((x) => x.id)).toEqual([created.brandId]);
    expect(await repos(a.tenant, a.other).brands.listActive()).toEqual([]);
    expect(await repos(b.tenant, b.member).brands.listActive()).toEqual([]);
    expect(await repos(a.tenant, a.other).products.create({ brandId: created.brandId })).toEqual({ ok: false, code: 'brand_not_found' });
    expect(await repos(a.tenant, a.other).products.listByBrand(created.brandId)).toEqual([]);
    expect(await repos(a.tenant, a.other).brands.archive(created.brandId)).toBe(false);
  });

  it('two concurrent create() calls at limit-1 admit exactly one', async () => {
    const { tenant, member } = await createTenant();
    await owner.query(`UPDATE tenants SET max_brands_per_user = 2 WHERE id = $1`, [tenant.id]);
    expect((await repos(tenant, member).brands.create({})).ok).toBe(true);
    const results = await Promise.all([repos(tenant, member).brands.create({}), repos(tenant, member).brands.create({})]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'brand_limit_reached', limit: 2 });
  });

  it('archiving frees a slot; lowering a limit keeps existing brands', async () => {
    const { tenant, member } = await createTenant();
    await owner.query(`UPDATE tenants SET max_brands_per_user = 1 WHERE id = $1`, [tenant.id]);
    const first = await repos(tenant, member).brands.create({});
    if (!first.ok) throw new Error('expected brand');
    expect((await repos(tenant, member).brands.create({})).ok).toBe(false);
    expect(await repos(tenant, member).brands.archive(first.brandId)).toBe(true);
    expect((await repos(tenant, member).brands.create({})).ok).toBe(true);
    await owner.query(`UPDATE tenants SET max_brands_per_user = 0 WHERE id = $1`, [tenant.id]);
    expect(await repos(tenant, member).brands.listActive()).toHaveLength(1);
  });

  it('a member cannot change the limits; an admin can; out-of-range values are refused by the database', async () => {
    const { tenant, admin, member } = await createTenant();
    await expect(repos(tenant, member).brands.setLimits({ maxBrandsPerUser: 99, maxConversationsPerBrand: 99 })).rejects.toBeInstanceOf(NotTenantAdminError);
    await expect(withTenantTransaction(tenant, member, (tx) => tx.query(`UPDATE tenants SET max_brands_per_user = 99 WHERE id = $1`, [tenant.id])))
      .rejects.toThrow(/permission denied/);
    await expect(withTenantTransaction(tenant, member, (tx) => tx.query(`SELECT app.set_brand_limits(99, 99)`))).rejects.toThrow(/tenant admin required/);

    await repos(tenant, admin).brands.setLimits({ maxBrandsPerUser: 7, maxConversationsPerBrand: 8 });
    expect(await repos(tenant, member).brands.getLimits()).toEqual({ maxBrandsPerUser: 7, maxConversationsPerBrand: 8 });
    await expect(repos(tenant, admin).brands.setLimits({ maxBrandsPerUser: 1001, maxConversationsPerBrand: 1 })).rejects.toThrow(/between 0 and 1000/);
  });
});
