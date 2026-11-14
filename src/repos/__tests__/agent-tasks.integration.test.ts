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
      agentId: 'test-fixture-agent',
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
      agentId: 'test-fixture-agent',
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

  it('lists only due pending dispatches for the requested agent within the limit', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    const insert = (agentId: string, scheduledFor?: string) => sys.agentTasks.insertRoot({
      conversationId,
      agentId,
      agentCardVersion: '1.0.0',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: {},
      scheduledFor,
    });

    await Promise.all([
      insert('logo-agent'),
      insert('logo-agent'),
      insert('other-agent'),
      insert('logo-agent', new Date(Date.now() + 60_000).toISOString()),
    ]);

    const rows = await sys.agentTasks.listPendingDispatches({ agentId: 'logo-agent', limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.agentId === 'logo-agent' && row.status === 'pending')).toBe(true);
    expect(rows.every((row) => Date.parse(row.scheduledFor) <= Date.now())).toBe(true);
  });

  it('claimById with an agent id leaves a task for another agent pending', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    const row = await sys.agentTasks.insertRoot({
      conversationId,
      agentId: 'tagline-agent',
      agentCardVersion: '1.0.0',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: {},
    });

    expect(await sys.agentTasks.claimById(row.id, 'logo-agent')).toBeNull();
    expect((await sys.agentTasks.findById(row.id))?.status).toBe('pending');
    const owned = await sys.agentTasks.claimById(row.id, 'tagline-agent');
    expect(owned?.status).toBe('in_progress');
  });

  it('durably settles a failed task with its error detail and classified category (KAN-58)', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    const row = await sys.agentTasks.insertRoot({
      conversationId,
      agentId: 'logo-agent',
      agentCardVersion: '1.0.0',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: {},
    });
    await sys.agentTasks.claimById(row.id, 'logo-agent');

    const settled = await repos({ id: tenantId }, { id: userId }).aiTurns.settleTaskAndEnqueue({
      conversationId,
      taskId: row.id,
      state: 'failed',
      deliverableKind: 'logo',
      artifacts: [],
      error: { kind: 'content_policy', message: 'synthetic safety rejection' },
      errorCategory: 'content_policy',
    });

    expect(settled.deliverableIds).toEqual([]);
    const stored = await sys.agentTasks.findById(row.id);
    expect(stored).toMatchObject({
      status: 'failed',
      errorCategory: 'content_policy',
      error: { kind: 'content_policy', message: 'synthetic safety rejection' },
    });
  });

  it('sweep fails an in_progress task older than 10 minutes and leaves a fresh one alone', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    const mk = async () => {
      const row = await sys.agentTasks.insertRoot({
        conversationId, agentId: 'logo-agent', agentCardVersion: '1.0.0', idempotencyKey: randomUUID(), requirementsSnapshot: {},
      });
      await sys.agentTasks.claimById(row.id, 'logo-agent');
      return row.id;
    };
    const fresh = await mk();
    const stale = await mk();
    // Age the stale claim by backdating last_attempt_at through the owner connection.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`UPDATE agent_tasks SET last_attempt_at = now() - interval '11 minutes' WHERE id = $1`, [stale]);
    } finally {
      await admin.end();
    }
    expect(await sys.aiEvents!.failStaleInProgress()).toBeGreaterThanOrEqual(1);
    expect(await sys.agentTasks.findById(stale)).toMatchObject({ status: 'failed', errorCategory: 'transient', error: { kind: 'timeout' } });
    expect((await sys.agentTasks.findById(fresh))?.status).toBe('in_progress');
    // A late worker result is ignored: the failure stays.
    const late = await repos({ id: tenantId }, { id: userId }).aiTurns.settleTaskAndEnqueue({
      conversationId, taskId: stale, state: 'completed', deliverableKind: 'logo', artifacts: [],
    });
    expect(late.applied).toBe(false);
    expect((await sys.agentTasks.findById(stale))?.status).toBe('failed');
  });

  it('rejects JSONB writes that embed a UUID not visible under the current tenant', async () => {
    const conversationId = await newConversation();
    const sys = systemRepos({ id: tenantId });
    // A random UUID that doesn't correspond to any row visible to us.
    const foreignUuid = randomUUID();
    await expect(
      sys.agentTasks.insertRoot({
        conversationId,
        agentId: 'test-fixture-agent',
        agentCardVersion: '1.0.0',
        idempotencyKey: randomUUID(),
        requirementsSnapshot: { reference: foreignUuid },
      }),
    ).rejects.toThrow(/JSONB tenant safety/);
  });

  it('accepts lab-report refs (brand_files id, tenant/brand ids in storageKey) and rejects a foreign tenant brand file', async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const mk = async (tid: string, uid: string | null) => {
      const brandId = randomUUID();
      const fileId = randomUUID();
      const owner = uid ?? randomUUID();
      if (!uid) {
        await admin.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tid, `jsonb ${tid}`]);
        await admin.query(
          `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'member', 'active')`,
          [owner, tid, `w-${owner}`, `${owner}@example.test`],
        );
      }
      await admin.query(`INSERT INTO brands (id, tenant_id, user_id) VALUES ($1, $2, $3)`, [brandId, tid, owner]);
      await admin.query(
        `INSERT INTO brand_files (id, tenant_id, user_id, brand_id, kind, storage_key, content_type, byte_size, sha256, original_name)
         VALUES ($1, $2, $3, $4, 'asset', 'k', 'application/pdf', 1, $5, 'a.pdf')`,
        [fileId, tid, owner, brandId, 'a'.repeat(64)],
      );
      return { brandId, fileId };
    };
    const foreignTenant = randomUUID();
    try {
      const own = await mk(tenantId, userId);
      const foreign = await mk(foreignTenant, null);
      const conversationId = await newConversation();
      const sys = systemRepos({ id: tenantId });
      const ref = (t: string, b: string, f: string) => ({
        lab_reports: [{ fileId: f, storageKey: `tenants/${t}/brands/${b}/files/${f}.pdf`, sha256: 'a'.repeat(64), originalName: 'a.pdf' }],
      });
      await expect(sys.agentTasks.insertRoot({
        conversationId, agentId: 'test-fixture-agent', agentCardVersion: '1.0.0',
        idempotencyKey: randomUUID(), requirementsSnapshot: ref(tenantId, own.brandId, own.fileId),
      })).resolves.toBeDefined();
      await expect(sys.agentTasks.insertRoot({
        conversationId, agentId: 'test-fixture-agent', agentCardVersion: '1.0.0',
        idempotencyKey: randomUUID(), requirementsSnapshot: { lab_reports: [{ fileId: foreign.fileId }] },
      })).rejects.toThrow(/JSONB tenant safety/);
    } finally {
      await admin.query(`DELETE FROM brand_files WHERE tenant_id = ANY($1::uuid[])`, [[tenantId, foreignTenant]]);
      await admin.query(`DELETE FROM brands WHERE tenant_id = ANY($1::uuid[])`, [[tenantId, foreignTenant]]);
      await admin.query(`DELETE FROM users WHERE tenant_id = $1`, [foreignTenant]);
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [foreignTenant]);
      await admin.end();
    }
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
