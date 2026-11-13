/**
 * Integration test for the messages repository.
 *
 * Conversation rows are created here under the seeded pilot tenant/user;
 * `ON DELETE CASCADE` on the messages → conversations FK does the cleanup.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { closePool } from '../../db/pool';
import { repos } from '..';
import type { ConversationId, UUID } from '../../core/contracts';

const SUITE = process.env.APP_DATABASE_URL ? describe : describe.skip;

async function fetchPilotIds(): Promise<{ tenantId: UUID; userId: UUID }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const t = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE name = 'Pilot Institution' LIMIT 1`,
    );
    const u = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
      [t.rows[0].id],
    );
    return { tenantId: t.rows[0].id, userId: u.rows[0].id };
  } finally {
    await client.end();
  }
}

async function deleteConversation(id: UUID): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DELETE FROM conversations WHERE id = $1`, [id]);
  } finally {
    await client.end();
  }
}

SUITE('messages repository (integration)', () => {
  let tenantId: UUID;
  let userId: UUID;
  const conversationIds: ConversationId[] = [];

  beforeAll(async () => {
    const ids = await fetchPilotIds();
    tenantId = ids.tenantId;
    userId = ids.userId;
  });

  afterEach(async () => {
    while (conversationIds.length > 0) {
      const id = conversationIds.pop()!;
      await deleteConversation(id);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('inserts and lists messages for a conversation', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const r = repos({ id: tenantId }, { id: userId });

    await r.conversations.getOrCreate(conversationId, []);
    const userMsg = await r.messages.insert({
      conversationId,
      role: 'user',
      content: 'Hola',
    });
    const asstMsg = await r.messages.insert({
      conversationId,
      role: 'assistant',
      content: '¡Hola!',
    });
    expect(userMsg.id).not.toBe(asstMsg.id);

    const listed = await r.messages.listByConversation(conversationId);
    expect(listed).toHaveLength(2);
    expect(listed[0].role).toBe('user');
    expect(listed[0].content).toBe('Hola');
    expect(listed[1].role).toBe('assistant');
  });

  it('marks a message complete', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const r = repos({ id: tenantId }, { id: userId });

    await r.conversations.getOrCreate(conversationId, []);
    const m = await r.messages.insert({
      conversationId,
      role: 'assistant',
      content: 'streaming...',
      generationStatus: 'pending',
    });
    await r.messages.markComplete(m.id);
    const [reread] = await r.messages.listByConversation(conversationId);
    expect(reread.generationStatus).toBe('complete');
    expect(reread.completedAt).not.toBeNull();
  });

  it('hides messages from foreign tenant context (RLS USING)', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const r = repos({ id: tenantId }, { id: userId });
    await r.conversations.getOrCreate(conversationId, []);
    await r.messages.insert({ conversationId, role: 'user', content: 'secret' });

    const foreignTenantId = randomUUID();
    const foreign = repos({ id: foreignTenantId }, { id: userId });
    const visible = await foreign.messages.listByConversation(conversationId);
    expect(visible).toHaveLength(0);
  });

  it('replaces the welcome while there are no turns and reads it back', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const r = repos({ id: tenantId }, { id: userId });
    await r.conversations.getOrCreate(conversationId, []);
    expect(await r.messages.readWelcome(conversationId)).toBeNull();
    expect(await r.messages.replaceWelcome(conversationId, 'uno')).toBe(true);
    expect(await r.messages.replaceWelcome(conversationId, 'dos')).toBe(true);
    expect(await r.messages.readWelcome(conversationId)).toBe('dos');
    expect(await r.messages.listByConversation(conversationId)).toHaveLength(1);
  });
});
