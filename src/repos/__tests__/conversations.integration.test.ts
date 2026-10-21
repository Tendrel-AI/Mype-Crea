/** Real PostgreSQL regression for serialized agent_states mutations. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { closePool } from '../../db/pool';
import { repos } from '..';
import type { ConversationId, UUID } from '../../core/contracts';

const SUITE = process.env.APP_DATABASE_URL ? describe : describe.skip;
const schemas = [{
  agentId: 'logo' as const,
  displayOrder: 1,
  requiredFields: ['business_name', 'product_description'] as const,
  optionalFields: [] as const,
}];

async function fetchPilotIds(): Promise<{ tenantId: UUID; userId: UUID }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE name = 'Pilot Institution' LIMIT 1`,
    );
    const user = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
      [tenant.rows[0].id],
    );
    return { tenantId: tenant.rows[0].id, userId: user.rows[0].id };
  } finally {
    await client.end();
  }
}

async function deleteConversation(id: ConversationId): Promise<void> {
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

async function waitForBlockedStateWriters(
  observer: pg.Client,
  blockerPid: number,
  expected: number,
): Promise<void> {
  // Observe PostgreSQL lock waits instead of relying on Promise scheduling.
  // The short bounded poll is synchronization on database state, not a test delay.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND pg_blocking_pids(pid) @> ARRAY[$1::int]
          AND query LIKE '%SELECT tenant_id, agent_states, started_at%'
          AND query LIKE '%FOR UPDATE%'`,
      [blockerPid],
    );
    if (result.rows[0]?.count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} agent_states writers to block on row lock`);
}

SUITE('conversations repository concurrency (integration)', () => {
  let tenantId: UUID;
  let userId: UUID;
  const conversationIds: ConversationId[] = [];

  beforeAll(async () => {
    ({ tenantId, userId } = await fetchPilotIds());
  });

  afterEach(async () => {
    while (conversationIds.length) await deleteConversation(conversationIds.pop()!);
  });

  afterAll(async () => closePool());

  it('preserves distinct field updates concurrent with a dispatch marker', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const conversationRepo = repos({ id: tenantId }, { id: userId }).conversations;
    await conversationRepo.getOrCreate(conversationId, schemas);

    const blocker = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([blocker.connect(), observer.connect()]);
    await blocker.query('BEGIN');
    await blocker.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await blocker.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const pid = await blocker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
    await blocker.query(
      `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );

    const writes = Promise.all([
      conversationRepo.updateFieldSlot(conversationId, 'logo', 'business_name', true, {
        status: 'filled', value: 'Tienda Sol', confidence: 1,
      }, schemas),
      conversationRepo.updateFieldSlot(conversationId, 'logo', 'product_description', true, {
        status: 'filled', value: 'Velas artesanales', confidence: 1,
      }, schemas),
      conversationRepo.recordDispatch(conversationId, 'logo', randomUUID(), schemas),
    ]);

    try {
      await waitForBlockedStateWriters(observer, pid.rows[0].pid, 1);
    } finally {
      await blocker.query('COMMIT');
      await Promise.all([blocker.end(), observer.end()]);
    }
    await writes;

    const snapshot = await conversationRepo.get(conversationId, schemas);
    expect(snapshot?.agentStates.logo).toMatchObject({
      requiredFields: {
        business_name: { status: 'filled', value: 'Tienda Sol' },
        product_description: { status: 'filled', value: 'Velas artesanales' },
      },
      iterationCount: 1,
    });
    expect(snapshot?.agentStates.logo.lastDispatchedTaskId).toBeTruthy();
  });

  it('preserves a field update when clearDispatch overlaps it', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const conversationRepo = repos({ id: tenantId }, { id: userId }).conversations;
    await conversationRepo.getOrCreate(conversationId, schemas);
    await conversationRepo.recordDispatch(conversationId, 'logo', randomUUID(), schemas);

    const blocker = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([blocker.connect(), observer.connect()]);
    await blocker.query('BEGIN');
    await blocker.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await blocker.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const pid = await blocker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
    await blocker.query(
      `SELECT id FROM conversations WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );

    const writes = Promise.all([
      conversationRepo.clearDispatch(conversationId, 'logo', schemas),
      conversationRepo.updateFieldSlot(conversationId, 'logo', 'business_name', true, {
        status: 'filled', value: 'Tienda Sol', confidence: 1,
      }, schemas),
    ]);
    try {
      await waitForBlockedStateWriters(observer, pid.rows[0].pid, 1);
    } finally {
      await blocker.query('COMMIT');
      await Promise.all([blocker.end(), observer.end()]);
    }
    await writes;

    const snapshot = await conversationRepo.get(conversationId, schemas);
    expect(snapshot?.agentStates.logo.requiredFields.business_name).toMatchObject({
      status: 'filled', value: 'Tienda Sol',
    });
    expect(snapshot?.agentStates.logo.lastDispatchedTaskId).toBeUndefined();
    expect(snapshot?.agentStates.logo.iterationCount).toBe(1);
  });

  it('uses serialized last-writer-wins semantics for the same field', async () => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const conversationRepo = repos({ id: tenantId }, { id: userId }).conversations;
    await conversationRepo.getOrCreate(conversationId, schemas);

    await conversationRepo.updateFieldSlot(conversationId, 'logo', 'business_name', true, {
      status: 'filled', value: 'Primero', confidence: 1,
    }, schemas);
    await conversationRepo.updateFieldSlot(conversationId, 'logo', 'business_name', true, {
      status: 'filled', value: 'Después', confidence: 1,
    }, schemas);

    const snapshot = await conversationRepo.get(conversationId, schemas);
    expect(snapshot?.agentStates.logo.requiredFields.business_name).toMatchObject({
      status: 'filled', value: 'Después',
    });
  });
});
