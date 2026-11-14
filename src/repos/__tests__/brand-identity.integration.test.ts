/**
 * KAN-89 brand-level identity against a disposable PostgreSQL database (same guard as brands.integration).
 * DATABASE_URL (owner) only seeds and inspects; every product path runs as app_user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closePool, getPool } from '../../db/pool';
import { repos, type Tenant, type User } from '..';
import type { ConversationId, UUID } from '../../core/contracts';
import { UPSTREAM_SNAPSHOT_KEY } from '../../core/deliverable-inputs';
import type { DeliverableSpec } from '../../core/orchestrator/agent-registry';
import { deriveStaleCandidateIds } from '../../core/orchestrator/deliverable-state';
import { PostgresDeliverableWorkflowStore } from '../../core/orchestrator/postgres-workflow';

const RUN_INTEGRATION = Boolean(process.env.APP_DATABASE_URL && process.env.DATABASE_URL);
const SUITE = RUN_INTEGRATION ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) throw new Error('Brand identity integration tests require one disposable database ending in _ci or _test');
  if (owner.hostname !== app.hostname || owner.port !== app.port) throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  if (owner.username === 'app_user' || app.username !== 'app_user') throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
}

SUITE('KAN-89 brand identity (integration)', () => {
  let owner: pg.Client;

  async function createTenant(): Promise<{ tenant: Tenant; me: User; other: User }> {
    const tenantId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `KAN-89 ${tenantId}`]);
    const mk = async (): Promise<User> => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'member', 'active')`,
        [id, tenantId, `kan89-${id}`, `${id}@example.invalid`],
      );
      return { id };
    };
    const me = await mk();
    // A frozen, activated release so conversations can be pinned (replica mode skips the freeze triggers).
    const releaseId = randomUUID();
    await owner.query('BEGIN');
    try {
      await owner.query(`SET LOCAL session_replication_role = 'replica'`);
      await owner.query(
        `INSERT INTO ai_releases (id, tenant_id, name, status, manifest, canonical_content, content_hash, created_by, updated_by, frozen_at)
         VALUES ($1, $2, $3, 'frozen', '{}'::jsonb, '{}', $4, $5, $5, now())`,
        [releaseId, tenantId, `KAN-89 ${releaseId}`, 'a'.repeat(64), me.id],
      );
      await owner.query(`INSERT INTO ai_release_activations (tenant_id, release_id, version, updated_by) VALUES ($1, $2, 1, $3)`, [tenantId, releaseId, me.id]);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
    return { tenant: { id: tenantId }, me, other: await mk() };
  }

  /** A brand with its brand chat, a second brand chat and a product chat. */
  async function seed() {
    const { tenant, me, other } = await createTenant();
    const r = repos(tenant, me);
    const brandChat = randomUUID() as ConversationId;
    const created = await r.brands.create({ name: 'Sol', attributes: { business_name: 'Sol', business_category: 'Panadería', market_proposition: 'Pan artesanal', target_audience: 'Familias' }, firstConversation: { conversationId: brandChat, schemas: [] } });
    if (!created.ok) throw new Error('brand');
    const brandId = created.brandId;
    const product = await r.products.create({ brandId, name: 'Pan' });
    if (!product.ok) throw new Error('product');
    const productChat = randomUUID() as ConversationId;
    const pc = await r.brands.createConversation({ conversationId: productChat, schemas: [], brandId, productId: product.product.id });
    if (!pc.ok) throw new Error('product chat');
    const secondChat = randomUUID() as ConversationId;
    const sc = await r.brands.createConversation({ conversationId: secondChat, schemas: [], brandId });
    if (!sc.ok) throw new Error('second chat');
    return { tenant, me, other, brandId, brandChat, productChat, secondChat };
  }

  async function candidate(t: Tenant, u: User, conversationId: ConversationId, kind: string, content: unknown = { v: 1 }, snapshot: Record<string, unknown> = {}): Promise<UUID> {
    const task = await repos(t, u).agentTasks.insertRoot({
      conversationId, agentId: `${kind}-agent`, agentCardVersion: 'kan89', idempotencyKey: randomUUID(), requirementsSnapshot: snapshot, owner: u,
    });
    const d = await repos(t, u).deliverables.insert({ conversationId, agentTaskId: task.id, kind: kind as never, contentInline: content as Record<string, unknown> });
    await repos(t, u).agentTasks.markCompleted(task.id);
    return d.id;
  }

  const approve = (t: Tenant, u: User, conversationId: ConversationId, kind: string, deliverableId: UUID, expected: UUID | null, brandLevel = true) =>
    repos(t, u).approvals.approve({ conversationId, deliverableKind: kind as never, deliverableId, expectedApprovedId: expected, dependentKinds: [], brandLevel });

  beforeAll(async () => {
    assertDisposableTarget(process.env.DATABASE_URL!, process.env.APP_DATABASE_URL!);
    owner = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await owner.connect();
    const who = await getPool().query<{ current_user: string }>('SELECT current_user');
    if (who.rows[0]?.current_user !== 'app_user') throw new Error('APP_DATABASE_URL must be app_user');
  });

  afterAll(async () => {
    await owner?.end();
    await closePool();
  });

  it('an approval in one chat is the approved result in every chat of the brand, product chats included', async () => {
    const s = await seed();
    const logo = await candidate(s.tenant, s.me, s.brandChat, 'logo');
    const out = await approve(s.tenant, s.me, s.brandChat, 'logo', logo, null);
    expect(out.kind).toBe('approved');
    for (const c of [s.brandChat, s.secondChat, s.productChat]) {
      const approved = await repos(s.tenant, s.me).approvals.getApproved(c);
      expect(approved.find((a) => a.deliverableKind === 'logo')?.deliverableId).toBe(logo);
    }
  });

  it('a replacement moves the brand pointer, so a product version built on the old one no longer matches', async () => {
    const s = await seed();
    const logo1 = await candidate(s.tenant, s.me, s.brandChat, 'logo');
    await approve(s.tenant, s.me, s.brandChat, 'logo', logo1, null);
    const logo2 = await candidate(s.tenant, s.me, s.secondChat, 'logo');
    expect((await approve(s.tenant, s.me, s.secondChat, 'logo', logo2, logo1)).kind).toBe('approved');
    const inProduct = (await repos(s.tenant, s.me).approvals.getApproved(s.productChat)).find((a) => a.deliverableKind === 'logo');
    expect(inProduct?.deliverableId).toBe(logo2);
    const foreign = await repos(s.tenant, s.me).deliverables.listBrandApprovedElsewhere(s.productChat);
    expect(foreign.map((f) => f.id)).toContain(logo2);
  });

  it('a stale expectation is rejected (the second concurrent approval loses)', async () => {
    const s = await seed();
    const a = await candidate(s.tenant, s.me, s.brandChat, 'logo');
    const b = await candidate(s.tenant, s.me, s.secondChat, 'logo');
    const [x, y] = await Promise.all([approve(s.tenant, s.me, s.brandChat, 'logo', a, null), approve(s.tenant, s.me, s.secondChat, 'logo', b, null)]);
    expect([x.kind, y.kind].sort()).toEqual(['approved', 'rejected']);
    const rejected = [x, y].find((o) => o.kind === 'rejected');
    expect(rejected).toMatchObject({ reason: 'stale' });
  });

  it('is owner only: another user of the tenant cannot read or write the brand approvals', async () => {
    const s = await seed();
    const logo = await candidate(s.tenant, s.me, s.brandChat, 'logo');
    await approve(s.tenant, s.me, s.brandChat, 'logo', logo, null);
    expect(await repos(s.tenant, s.other).approvals.getApproved(s.brandChat)).toEqual([]);
    expect((await approve(s.tenant, s.other, s.brandChat, 'logo', logo, null)).kind).toBe('rejected');
    const seen = await owner.query(`SELECT count(*)::int AS n FROM brand_approvals WHERE brand_id = $1`, [s.brandId]);
    expect(seen.rows[0].n).toBe(1);
  });

  it('approving a name sets the brand record name and business_name', async () => {
    const s = await seed();
    const name = await candidate(s.tenant, s.me, s.brandChat, 'business_name', { value: 'Sol de Oro', kind: 'text' });
    expect((await approve(s.tenant, s.me, s.brandChat, 'business_name', name, null)).kind).toBe('approved');
    const brand = await repos(s.tenant, s.me).brands.get(s.brandId);
    expect(brand?.name).toBe('Sol de Oro');
    expect(brand?.attributes.business_name).toBe('Sol de Oro');
  });

  it('own candidates: only in a brand chat, never in a product chat or a foreign conversation', async () => {
    const s = await seed();
    const input = (conversationId: ConversationId) => ({
      deliverableId: randomUUID() as UUID, conversationId, agentId: 'tagline-agent', agentCardVersion: 'kan89',
      deliverableKind: 'tagline', source: { text: 'Sabor de casa' },
    });
    expect(await repos(s.tenant, s.me).ownCandidates.insert(input(s.brandChat))).toBe(true);
    expect(await repos(s.tenant, s.me).ownCandidates.insert(input(s.productChat))).toBe(false);
    expect(await repos(s.tenant, s.other).ownCandidates.insert(input(s.brandChat))).toBe(false);
    expect(await repos(s.tenant, s.me).ownCandidates.findBrandLogo(s.brandChat)).toBeNull();
  });

  it('a product version records the brand logo as upstream (another conversation, tenant-only dispatch) and goes stale when the logo is replaced', async () => {
    const s = await seed();
    const logo1 = await candidate(s.tenant, s.me, s.brandChat, 'logo');
    await approve(s.tenant, s.me, s.brandChat, 'logo', logo1, null);
    // Succeeds: the guard checks tenant scope, not the owner axis the tenant-only transaction lacks.
    const label = await candidate(s.tenant, s.me, s.productChat, 'label', { v: 1 }, { [UPSTREAM_SNAPSHOT_KEY]: { logo: logo1 } });
    // A UUID from another tenant is still refused.
    const foreign = await seed();
    const foreignLogo = await candidate(foreign.tenant, foreign.me, foreign.brandChat, 'logo');
    await expect(candidate(s.tenant, s.me, s.productChat, 'label', { v: 1 }, { [UPSTREAM_SNAPSHOT_KEY]: { logo: foreignLogo } })).rejects.toThrow(/tenant safety/);

    const specs: DeliverableSpec[] = [
      { agentId: 'logo-agent', deliverableKind: 'logo', requiredFields: [], dependsOn: [], level: 'brand' },
      { agentId: 'label-agent', deliverableKind: 'label', requiredFields: [], dependsOn: ['logo'], level: 'product' },
    ];
    const staleIds = async () => {
      const store = new PostgresDeliverableWorkflowStore(s.tenant.id, s.me.id);
      const approved = await repos(s.tenant, s.me).approvals.getApproved(s.productChat);
      const snapshot = { conversationId: s.productChat, tenantId: s.tenant.id, agentStates: {}, updatedAt: '', links: { hasBrand: true, hasProduct: true } } as never;
      return deriveStaleCandidateIds(snapshot, specs, {
        tasks: await store.listTasks(s.productChat),
        candidates: await store.listCandidates(s.productChat),
        approvals: approved.map((a) => ({ deliverableKind: a.deliverableKind, deliverableId: a.deliverableId })),
        markedStaleKinds: [],
      });
    };
    expect(await staleIds()).not.toContain(label);

    const logo2 = await candidate(s.tenant, s.me, s.secondChat, 'logo');
    expect((await approve(s.tenant, s.me, s.secondChat, 'logo', logo2, logo1)).kind).toBe('approved');
    expect(await staleIds()).toContain(label);
  });

  it('approving a name writes it to a brand that lacks its other required attributes', async () => {
    const { tenant, me } = await createTenant();
    const brandChat = randomUUID() as ConversationId;
    const created = await repos(tenant, me).brands.create({ name: 'Provisional', attributes: { business_name: 'Provisional', name_pending: true }, firstConversation: { conversationId: brandChat, schemas: [] } });
    if (!created.ok) throw new Error('brand');
    const name = await candidate(tenant, me, brandChat, 'business_name', { value: 'Sol de Oro', kind: 'text' });
    expect((await approve(tenant, me, brandChat, 'business_name', name, null)).kind).toBe('approved');
    const brand = await repos(tenant, me).brands.get(created.brandId);
    expect(brand?.name).toBe('Sol de Oro');
    expect(brand?.attributes).toEqual({ business_name: 'Sol de Oro' }); // name_pending=false is stored as absent
  });
});
