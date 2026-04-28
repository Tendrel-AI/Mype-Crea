/**
 * Integration test for the agent_tasks repository.
 *
 * Covers:
 *   - root insert: iteration_root_id == id, iteration_number == 1
 *   - claimNextPending atomicity: parallel claimers see at most one winner
 *   - JSONB tenant safety: foreign UUIDs in requirements_snapshot rejected
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { closePool } from '../../db/pool';
import { repos, systemRepos } from '..';
import { __test as agentTasksInternals } from '../agent-tasks';
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

SUITE('agent_tasks repository (integration)', () => {
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

  async function newConversation(): Promise<ConversationId> {
    const id = randomUUID();
    conversationIds.push(id);
    await repos({ id: tenantId }, { id: userId }).conversations.getOrCreate(id, []);
    return id;
  }

  it('inserts a root task with iteration_root_id == id and iteration_number == 1', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    const row = await sys.agentTasks.insertRoot({
      conversationId,
      agentId: 'name-agent',
      agentCardVersion: '1.0.0',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: { business_name: 'Sazón Andino' },
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.iterationRootId).toBe(row.id);
    expect(row.iterationNumber).toBe(1);
    expect(row.parentTaskId).toBeNull();
    expect(row.status).toBe('pending');
  });

  it('claimNextPending returns at most one winner under parallel claimers', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    const row = await sys.agentTasks.insertRoot({
      conversationId,
      agentId: 'name-agent',
      agentCardVersion: '1.0.0',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: {},
    });

    const claims = await Promise.all([
      sys.agentTasks.claimNextPending(),
      sys.agentTasks.claimNextPending(),
      sys.agentTasks.claimNextPending(),
    ]);
    const winners = claims.filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(row.id);
    expect(winners[0]!.status).toBe('in_progress');
    expect(winners[0]!.attempts).toBe(1);
  });

  it('rejects JSONB writes that embed a UUID not visible under the current tenant', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    // A random UUID that doesn't correspond to any row visible to us.
    const foreignUuid = randomUUID();
    await expect(
      sys.agentTasks.insertRoot({
        conversationId,
        agentId: 'name-agent',
        agentCardVersion: '1.0.0',
        idempotencyKey: randomUUID(),
        requirementsSnapshot: { reference: foreignUuid },
      }),
    ).rejects.toThrow(/JSONB tenant safety/);
  });

  it('extractUuids finds embedded UUIDs in nested JSONB', () => {
    const u1 = randomUUID();
    const u2 = randomUUID();
    const found = agentTasksInternals.extractUuids({
      a: u1,
      nested: { b: [u2, 'plain-string', 42] },
    });
    expect(found).toEqual(new Set([u1.toLowerCase(), u2.toLowerCase()]));
  });
});
