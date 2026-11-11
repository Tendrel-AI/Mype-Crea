/**
 * Integration test for the per-conversation prompt pin (D22 part 2): set-once, owner-only.
 * Skipped unless DATABASE_URL (owner) and APP_DATABASE_URL are set; refuses any DB not ending _ci/_test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { repos } from '..';
import { closePool } from '../../db/pool';
import { ConversationUnavailableError } from '../conversations';

const SUITE = process.env.DATABASE_URL && process.env.APP_DATABASE_URL ? describe : describe.skip;

function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) throw new Error('Prompt pin integration tests require one disposable database ending in _ci or _test');
  if (owner.hostname !== app.hostname || owner.port !== app.port) throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  if (owner.username === 'app_user' || app.username !== 'app_user') throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
}

SUITE('conversationPrompts.pin (integration)', () => {
  const tenant = { id: randomUUID() };
  const admin = { id: randomUUID() }; // tenant admin: RLS lets them see the owner's conversation, the repo must not
  const ownerUser = { id: randomUUID() };
  const otherTenant = { id: randomUUID() };
  const otherUser = { id: randomUUID() };
  const conversationId = randomUUID();
  let owner: pg.Pool;

  beforeAll(async () => {
    assertDisposableTarget(process.env.DATABASE_URL!, process.env.APP_DATABASE_URL!);
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    for (const [t, u, role] of [[tenant, ownerUser, 'member'], [tenant, admin, 'admin'], [otherTenant, otherUser, 'admin']] as const) {
      await owner.query(`INSERT INTO tenants (id, kind, name) SELECT $1, 'institutional', $2 WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = $1)`, [t.id, `pin ${t.id}`]);
      await owner.query(`INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, $5, 'active')`, [u.id, t.id, `ci-${u.id}`, `${u.id}@example.invalid`, role]);
    }
    await repos(tenant, ownerUser).conversations.getOrCreate(conversationId as never, [] as never);
  });

  afterAll(async () => {
    await owner?.end();
    await closePool();
  });

  it('pins on the first call and returns the stored map on later calls, whatever they pass', async () => {
    const pins = repos(tenant, ownerUser).conversationPrompts;
    const first = { extractor: 'extractor.v5', 'logo-agent': 'logo-agent.v1' };
    expect(await pins.pin(conversationId as never, first)).toEqual(first);
    expect(await pins.pin(conversationId as never, { extractor: 'extractor.v7' })).toEqual(first);
    const row = await owner.query(`SELECT prompt_versions FROM conversations WHERE id = $1`, [conversationId]);
    expect(row.rows[0].prompt_versions).toEqual(first);
  });

  it('two concurrent first calls end with one stored map that both callers receive', async () => {
    const id = randomUUID();
    await repos(tenant, ownerUser).conversations.getOrCreate(id as never, [] as never);
    const pins = repos(tenant, ownerUser).conversationPrompts;
    const [a, b] = await Promise.all([pins.pin(id as never, { extractor: 'a' }), pins.pin(id as never, { extractor: 'b' })]);
    expect(a).toEqual(b);
  });

  it('refuses another user of the same tenant (even an admin), another tenant and an unknown conversation, and leaves the pin untouched', async () => {
    for (const [t, u] of [[tenant, admin], [otherTenant, otherUser]] as const) {
      await expect(repos(t, u).conversationPrompts.pin(conversationId as never, { extractor: 'x' })).rejects.toBeInstanceOf(ConversationUnavailableError);
    }
    await expect(repos(tenant, ownerUser).conversationPrompts.pin(randomUUID() as never, { extractor: 'x' })).rejects.toBeInstanceOf(ConversationUnavailableError);
    const row = await owner.query(`SELECT prompt_versions FROM conversations WHERE id = $1`, [conversationId]);
    expect(row.rows[0].prompt_versions).toEqual({ extractor: 'extractor.v5', 'logo-agent': 'logo-agent.v1' });
  });
});
