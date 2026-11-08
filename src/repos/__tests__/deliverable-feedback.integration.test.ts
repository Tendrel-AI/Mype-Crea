/**
 * Integration test for deliverable feedback (prompt ledger step 4): repo upsert/clear, the version
 * copied server-side, owner-only RLS, and the developer-only cross-tenant aggregate function.
 * Skipped unless DATABASE_URL (owner) and APP_DATABASE_URL are set; refuses any DB not ending _ci/_test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { repos } from '..';
import { closePool } from '../../db/pool';
import { PostgresLedgerStore } from '../../services/prompt-ledger/postgres-store';

const SUITE = process.env.DATABASE_URL && process.env.APP_DATABASE_URL ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) throw new Error('Feedback integration tests require one disposable database ending in _ci or _test');
  if (owner.hostname !== app.hostname || owner.port !== app.port) throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  if (owner.username === 'app_user' || app.username !== 'app_user') throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
}

SUITE('deliverable feedback (integration)', () => {
  const version = `itest-${randomUUID().slice(0, 8)}.v1`;
  const tenant = { id: randomUUID() };
  const owner_ = { id: randomUUID() };
  const member = { id: randomUUID() };
  const otherTenant = { id: randomUUID() };
  const otherTenantUser = { id: randomUUID() };
  const conversationId = randomUUID();
  let owner: pg.Pool;
  let deliverableId: string;

  beforeAll(async () => {
    assertDisposableTarget(process.env.DATABASE_URL!, process.env.APP_DATABASE_URL!);
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    for (const [t, u, role] of [[tenant, owner_, 'admin'], [tenant, member, 'member'], [otherTenant, otherTenantUser, 'admin']] as const) {
      await owner.query(`INSERT INTO tenants (id, kind, name) SELECT $1, 'institutional', $2 WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = $1)`, [t.id, `feedback ${t.id}`]);
      await owner.query(
        `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`,
        [u.id, t.id, `ci-${u.id}`, `${u.id}@example.invalid`, role],
      );
    }
    await repos(tenant, owner_).conversations.getOrCreate(conversationId as never, [] as never);
    const task = await repos(tenant, owner_).agentTasks.insertRoot({
      conversationId: conversationId as never, agentId: 'logo-agent', agentCardVersion: 'ci-test',
      idempotencyKey: randomUUID(), requirementsSnapshot: { business_name: 'synthetic' },
    });
    const d = await repos(tenant, owner_).deliverables.insert({ conversationId: conversationId as never, agentTaskId: task.id, kind: 'logo', contentInline: { x: 1 } });
    deliverableId = d.id;
    await owner.query(`UPDATE deliverables SET artifact_metadata = $2::jsonb WHERE id = $1`, [d.id, JSON.stringify({ promptVersion: version })]);
  });

  afterAll(async () => {
    await owner?.end();
    await closePool();
  });

  it('upserts, copies the prompt version server-side, changes and clears the rating', async () => {
    const fb = repos(tenant, owner_).deliverableFeedback;
    expect(await fb.set(conversationId as never, deliverableId as never, 'up')).toEqual({ found: true, value: 'up' });
    expect(await fb.set(conversationId as never, deliverableId as never, 'down')).toEqual({ found: true, value: 'down' });
    expect(await fb.listByConversation(conversationId as never)).toEqual({ [deliverableId]: 'down' });
    const row = await owner.query(`SELECT prompt_version FROM deliverable_feedback WHERE deliverable_id = $1`, [deliverableId]);
    expect(row.rows).toEqual([{ prompt_version: version }]);

    // Developer-only aggregate: opaque rater, no tenant, readable only by the owner role.
    const store = new PostgresLedgerStore(owner as never);
    const [entry] = await store.listFeedback('logo-agent', version);
    expect(entry).toMatchObject({ subjectId: deliverableId, value: 'down' });
    expect(entry.raterId).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain(tenant.id);
    expect(JSON.stringify(entry)).not.toContain(owner_.id);

    expect(await fb.set(conversationId as never, deliverableId as never, null)).toEqual({ found: true, value: null });
    expect(await fb.listByConversation(conversationId as never)).toEqual({});
  });

  it('clearing through another conversation of the same owner leaves the rating untouched', async () => {
    const fb = repos(tenant, owner_).deliverableFeedback;
    const otherConversation = randomUUID();
    await repos(tenant, owner_).conversations.getOrCreate(otherConversation as never, [] as never);
    await fb.set(conversationId as never, deliverableId as never, 'up');
    expect(await fb.set(otherConversation as never, deliverableId as never, null)).toEqual({ found: false, value: null });
    expect(await fb.listByConversation(conversationId as never)).toEqual({ [deliverableId]: 'up' });
    await fb.set(conversationId as never, deliverableId as never, null);
  });

  it('is owner-only: another member, another tenant and app_user on the function are all refused', async () => {
    await repos(tenant, owner_).deliverableFeedback.set(conversationId as never, deliverableId as never, 'up');
    for (const [t, u] of [[tenant, member], [otherTenant, otherTenantUser]] as const) {
      const stranger = repos(t, u).deliverableFeedback;
      expect((await stranger.set(conversationId as never, deliverableId as never, 'down')).found).toBe(false);
      expect(await stranger.listByConversation(conversationId as never)).toEqual({});
    }
    expect(await repos(tenant, owner_).deliverableFeedback.listByConversation(conversationId as never)).toEqual({ [deliverableId]: 'up' });

    const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL, max: 1 });
    try {
      await expect(app.query(`SELECT * FROM app.prompt_ledger_feedback($1)`, [version])).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
  });
});
