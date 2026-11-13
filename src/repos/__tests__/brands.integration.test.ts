/**
 * KAN-85 / KAN-87 brands, products, files and limits against a disposable PostgreSQL database (NOT run by the
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

  it('defaults the limits to 3 brands per user and 5 products per brand', async () => {
    const { tenant, member } = await createTenant();
    expect(await repos(tenant, member).limits.effectiveLimits()).toMatchObject({ 'brands.per_user': 3, 'products.per_brand': 5 });
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
    await owner.query(`UPDATE limit_profile_values SET value = 2 WHERE tenant_id = $1 AND limit_key = 'brands.per_user'`, [tenant.id]);
    expect((await repos(tenant, member).brands.create({})).ok).toBe(true);
    const results = await Promise.all([repos(tenant, member).brands.create({}), repos(tenant, member).brands.create({})]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'brand_limit_reached', limit: 2 });
  });

  it('archiving frees a slot; lowering a limit keeps existing brands', async () => {
    const { tenant, member } = await createTenant();
    await owner.query(`UPDATE limit_profile_values SET value = 1 WHERE tenant_id = $1 AND limit_key = 'brands.per_user'`, [tenant.id]);
    const first = await repos(tenant, member).brands.create({});
    if (!first.ok) throw new Error('expected brand');
    expect((await repos(tenant, member).brands.create({})).ok).toBe(false);
    expect(await repos(tenant, member).brands.archive(first.brandId)).toBe(true);
    expect((await repos(tenant, member).brands.create({})).ok).toBe(true);
    await owner.query(`UPDATE limit_profile_values SET value = 0 WHERE tenant_id = $1 AND limit_key = 'brands.per_user'`, [tenant.id]);
    expect(await repos(tenant, member).brands.listActive()).toHaveLength(1);
  });

  it('a member cannot change a profile value; an admin can, with an audit row; out-of-range values are refused by the database', async () => {
    const { tenant, admin, member } = await createTenant();
    const profile = await repos(tenant, admin).limits.getDefaultProfile();
    if (!profile) throw new Error('expected default profile');
    await expect(repos(tenant, member).limits.setValue({ profileId: profile.profileId, limitKey: 'brands.per_user', value: 99, reason: null })).rejects.toBeInstanceOf(NotTenantAdminError);
    await expect(withTenantTransaction(tenant, member, (tx) => tx.query(`SELECT app.set_limit_profile_value($1, 'brands.per_user', 99, null)`, [profile.profileId]))).rejects.toThrow(/tenant admin required/);
    await repos(tenant, admin).limits.setValue({ profileId: profile.profileId, limitKey: 'brands.per_user', value: 7, reason: 'piloto' });
    expect(await repos(tenant, member).limits.effectiveLimits()).toMatchObject({ 'brands.per_user': 7 });
    expect((await repos(tenant, admin).limits.getDefaultProfile())?.audit[0]).toMatchObject({ limitKey: 'brands.per_user', beforeValue: 3, afterValue: 7, reason: 'piloto' });
    await expect(repos(tenant, admin).limits.setValue({ profileId: profile.profileId, limitKey: 'brands.per_user', value: 1001, reason: null })).rejects.toThrow(/between 0 and 1000/);
  });

  it('two concurrent product creations at limit-1 admit exactly one (the brand row lock serializes them)', async () => {
    const { tenant, member } = await createTenant();
    await owner.query(`UPDATE limit_profile_values SET value = 2 WHERE tenant_id = $1 AND limit_key = 'products.per_brand'`, [tenant.id]);
    const brand = await repos(tenant, member).brands.create({ name: 'Café' });
    if (!brand.ok) throw new Error('expected brand');
    expect((await repos(tenant, member).products.create({ brandId: brand.brandId, name: 'Uno' })).ok).toBe(true);
    const results = await Promise.all([
      repos(tenant, member).products.create({ brandId: brand.brandId, name: 'Dos' }),
      repos(tenant, member).products.create({ brandId: brand.brandId, name: 'Tres' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'product_limit_reached', limit: 2 });
  });

  it('refuses a conversation whose product belongs to another brand or another user (FKs), and keeps valid ones', async () => {
    const { tenant, member, other } = await createTenant();
    const mine = await repos(tenant, member).brands.create({ name: 'Mía' });
    const mine2 = await repos(tenant, member).brands.create({ name: 'Mía 2' });
    const theirs = await repos(tenant, other).brands.create({ name: 'Ajena' });
    if (!mine.ok || !mine2.ok || !theirs.ok) throw new Error('expected brands');
    const product = await repos(tenant, member).products.create({ brandId: mine.brandId, name: 'Molido' });
    if (!product.ok) throw new Error('expected product');
    const insert = (id: string, userId: string, brandId: string, productId: string | null) => owner.query(
      `INSERT INTO conversations (id, tenant_id, user_id, brand_id, product_id) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenant.id, userId, brandId, productId],
    );
    await insert(randomUUID(), member.id, mine.brandId, product.product.id);
    await expect(insert(randomUUID(), member.id, mine2.brandId, product.product.id)).rejects.toThrow(/conversations_product_brand_fk/);
    await expect(insert(randomUUID(), other.id, theirs.brandId, product.product.id)).rejects.toThrow(/conversations_product_(brand|owner)_fk/);
    await expect(owner.query(
      `INSERT INTO conversations (id, tenant_id, user_id, product_id) VALUES ($1, $2, $3, $4)`, [randomUUID(), tenant.id, member.id, product.product.id],
    )).rejects.toThrow(/conversations_product_needs_brand/);
    // The repo answers the same cases with a typed refusal before reaching the FK.
    const refused = await repos(tenant, member).brands.createConversation({
      brandId: mine2.brandId, productId: product.product.id, conversationId: randomUUID() as never, schemas: [],
    });
    expect(refused).toEqual({ ok: false, code: 'product_not_found' });
  });

  it('isolates brand_files by owner and tenant, keeps one logo per brand and at most 5 assets', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const brand = await repos(a.tenant, a.member).brands.create({ name: 'Café' });
    if (!brand.ok) throw new Error('expected brand');
    const file = (kind: 'logo' | 'asset') => ({
      id: randomUUID() as never, brandId: brand.brandId, kind, storageKey: `k/${randomUUID()}`, contentType: 'image/png',
      byteSize: 10, sha256: 'a'.repeat(64), originalName: 'x.png',
    });
    const first = await repos(a.tenant, a.member).brandFiles.add(file('logo'));
    expect(first).toMatchObject({ ok: true });
    const second = await repos(a.tenant, a.member).brandFiles.add(file('logo'));
    expect(second).toMatchObject({ ok: true, replacedStorageKey: first.ok ? first.file.storageKey : undefined });
    expect((await repos(a.tenant, a.member).brandFiles.listByBrand(brand.brandId)).filter((f) => f.kind === 'logo')).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) expect((await repos(a.tenant, a.member).brandFiles.add(file('asset'))).ok).toBe(true);
    expect(await repos(a.tenant, a.member).brandFiles.add(file('asset'))).toEqual({ ok: false, code: 'asset_limit_reached', limit: 5 });

    const stored = await repos(a.tenant, a.member).brandFiles.listByBrand(brand.brandId);
    expect(await repos(a.tenant, a.other).brandFiles.listByBrand(brand.brandId)).toEqual([]);
    expect(await repos(b.tenant, b.member).brandFiles.listByBrand(brand.brandId)).toEqual([]);
    expect(await repos(a.tenant, a.other).brandFiles.get(stored[0].id)).toBeNull();
    expect(await repos(a.tenant, a.other).brandFiles.add(file('asset'))).toEqual({ ok: false, code: 'not_found' });
    await expect(withTenantTransaction(a.tenant, a.other, (tx) => tx.query(
      `INSERT INTO brand_files (tenant_id, user_id, brand_id, kind, storage_key, content_type, byte_size, sha256, original_name)
       VALUES ($1, $2, $3, 'asset', 'k', 'image/png', 1, 'x', 'x')`, [a.tenant.id, a.other.id, brand.brandId],
    ))).rejects.toThrow();
  });

  it('creates a brand with its first conversation and a product conversation, storing brand_id and product_id', async () => {
    const { tenant, member } = await createTenant();
    // A frozen, activated release so pinConversationInTx can pin (replica mode skips the freeze triggers).
    const releaseId = randomUUID();
    await owner.query('BEGIN');
    try {
      await owner.query(`SET LOCAL session_replication_role = 'replica'`);
      await owner.query(
        `INSERT INTO ai_releases (id, tenant_id, name, status, manifest, canonical_content, content_hash, created_by, updated_by, frozen_at)
         VALUES ($1, $2, $3, 'frozen', '{}'::jsonb, '{}', $4, $5, $5, now())`,
        [releaseId, tenant.id, `KAN-87 ${releaseId}`, 'a'.repeat(64), member.id],
      );
      await owner.query(
        `INSERT INTO ai_release_activations (tenant_id, release_id, version, updated_by) VALUES ($1, $2, 1, $3)`,
        [tenant.id, releaseId, member.id],
      );
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }

    const firstId = randomUUID() as never;
    const brand = await repos(tenant, member).brands.create({ name: 'Café', firstConversation: { conversationId: firstId, schemas: [] } });
    if (!brand.ok) throw new Error('expected brand');
    expect(brand.pin?.state).toBe('pinned');
    const product = await repos(tenant, member).products.create({ brandId: brand.brandId, name: 'Molido' });
    if (!product.ok) throw new Error('expected product');
    const productConversationId = randomUUID() as never;
    const second = await repos(tenant, member).brands.createConversation({
      brandId: brand.brandId, productId: product.product.id, conversationId: productConversationId, schemas: [],
    });
    expect(second.ok).toBe(true);

    const rows = await owner.query<{ id: string; brand_id: string; product_id: string | null; ai_release_id: string }>(
      `SELECT id, brand_id, product_id, ai_release_id FROM conversations WHERE tenant_id = $1`, [tenant.id],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(firstId)).toMatchObject({ brand_id: brand.brandId, product_id: null, ai_release_id: releaseId });
    expect(byId.get(productConversationId)).toMatchObject({ brand_id: brand.brandId, product_id: product.product.id });
  });
});
