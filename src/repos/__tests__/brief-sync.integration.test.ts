/**
 * KAN-88 brief <-> brand/product sync against a disposable PostgreSQL database (NOT run by the agent that
 * wrote it). Same setup rules as `brands.integration.test.ts`: DATABASE_URL (owner) only seeds and inspects,
 * every product path runs as app_user, and both URLs must point at the same database ending in _ci or _test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { repos, type Tenant, type User } from '..';
import type { AgentFieldSchema } from '../../core/orchestrator/in-memory-store';
import type { ConversationId, FieldSlot } from '../../core/contracts';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;
const SCHEMAS: AgentFieldSchema[] = [
  { agentId: 'logo-agent', requiredFields: ['business_name', 'business_category', 'product_name'], optionalFields: ['style_keywords'] },
] as never;
const filled = (value: string): FieldSlot => ({ status: 'filled', value, confidence: 1, source: 'chat' });

SUITE('KAN-88 brief sync (integration)', () => {
  let owner: pg.Client;

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL!;
    const owned = new URL(ownerUrl);
    const app = new URL(process.env.APP_DATABASE_URL!);
    const db = owned.pathname.slice(1);
    if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db || app.username !== 'app_user') throw new Error('Brief sync tests require one disposable database ending in _ci or _test, as app_user');
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if ((await getPool().query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
  });

  afterAll(async () => {
    await owner?.end();
    await closePool();
  });

  async function seed(): Promise<{ tenant: Tenant; user: User; brandId: string; productId: string; brandConv: ConversationId; productConv: ConversationId }> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const releaseId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `KAN-88 ${tenantId}`]);
    await owner.query(
      `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'member', 'active')`,
      [userId, tenantId, `kan88-${userId}`, `${userId}@example.invalid`],
    );
    // A frozen, activated release so conversations can be pinned (replica mode skips the freeze triggers).
    await owner.query('BEGIN');
    try {
      await owner.query(`SET LOCAL session_replication_role = 'replica'`);
      await owner.query(
        `INSERT INTO ai_releases (id, tenant_id, name, status, manifest, canonical_content, content_hash, created_by, updated_by, frozen_at)
         VALUES ($1, $2, $3, 'frozen', '{}'::jsonb, '{}', $4, $5, $5, now())`,
        [releaseId, tenantId, `KAN-88 ${releaseId}`, 'b'.repeat(64), userId],
      );
      await owner.query(`INSERT INTO ai_release_activations (tenant_id, release_id, version, updated_by) VALUES ($1, $2, 1, $3)`, [tenantId, releaseId, userId]);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
    const tenant = { id: tenantId };
    const user = { id: userId };
    const brandConv = randomUUID() as ConversationId;
    const brand = await repos(tenant, user).brands.create({
      name: 'Café Andino',
      attributes: { business_name: 'Café Andino', style_keywords: 'rústico' },
      firstConversation: { conversationId: brandConv, schemas: SCHEMAS },
    });
    if (!brand.ok) throw new Error('expected brand');
    const product = await repos(tenant, user).products.create({ brandId: brand.brandId, name: 'Molido', attributes: { product_name: 'Molido' } });
    if (!product.ok) throw new Error('expected product');
    const productConv = randomUUID() as ConversationId;
    const second = await repos(tenant, user).brands.createConversation({ brandId: brand.brandId, productId: product.product.id, conversationId: productConv, schemas: SCHEMAS });
    if (!second.ok) throw new Error('expected conversation');
    return { tenant, user, brandId: brand.brandId, productId: product.product.id, brandConv, productConv };
  }

  const brandAttributes = async (id: string) => (await owner.query<{ attributes: Record<string, unknown>; name: string }>('SELECT attributes, name FROM brands WHERE id = $1', [id])).rows[0];

  it('shows form values as filled slots in the snapshot', async () => {
    const { tenant, user, brandConv, productConv } = await seed();
    for (const id of [brandConv, productConv]) {
      const snap = await repos(tenant, user).conversations.get(id, SCHEMAS);
      const slots = snap!.agentStates['logo-agent'];
      expect(slots.requiredFields.business_name).toMatchObject({ status: 'filled', value: 'Café Andino' });
      expect(slots.optionalFields.style_keywords).toMatchObject({ status: 'filled', value: 'rústico' });
    }
    const productSlots = (await repos(tenant, user).conversations.get(productConv, SCHEMAS))!.agentStates['logo-agent'].requiredFields;
    expect(productSlots.product_name).toMatchObject({ status: 'filled', value: 'Molido' });
    const brandSlots = (await repos(tenant, user).conversations.get(brandConv, SCHEMAS))!.agentStates['logo-agent'].requiredFields;
    expect(brandSlots.product_name).toEqual({ status: 'empty' });
  });

  it('a category confirmed in a product conversation lands in the brand and shows in the brand conversation; product fields stay per product', async () => {
    const { tenant, user, brandId, productId, brandConv, productConv } = await seed();
    const conversations = repos(tenant, user).conversations;
    await conversations.updateFieldSlot(productConv, 'logo-agent', 'business_category', true, filled('Cafetería'), SCHEMAS);
    await conversations.updateFieldSlot(productConv, 'logo-agent', 'product_name', true, filled('Molido fino'), SCHEMAS);

    expect((await brandAttributes(brandId)).attributes).toMatchObject({ business_category: 'Cafetería', business_name: 'Café Andino' });
    const product = (await owner.query<{ attributes: Record<string, unknown>; name: string }>('SELECT attributes, name FROM products WHERE id = $1', [productId])).rows[0];
    expect(product).toMatchObject({ name: 'Molido fino', attributes: { product_name: 'Molido fino' } });

    const other = (await conversations.get(brandConv, SCHEMAS))!.agentStates['logo-agent'].requiredFields;
    expect(other.business_category).toMatchObject({ status: 'filled', value: 'Cafetería' });
    expect(other.product_name).toEqual({ status: 'empty' });
  });

  it('concurrent write-backs from two conversations of one brand do not deadlock', async () => {
    const { tenant, user, brandId, brandConv, productConv } = await seed();
    const conversations = repos(tenant, user).conversations;
    await Promise.all([
      conversations.updateFieldSlot(brandConv, 'logo-agent', 'business_category', true, filled('Panadería'), SCHEMAS),
      conversations.updateFieldSlot(productConv, 'logo-agent', 'style_keywords', false, filled('moderno'), SCHEMAS),
    ]);
    expect((await brandAttributes(brandId)).attributes).toMatchObject({ business_category: 'Panadería', style_keywords: 'moderno' });
  });
});
