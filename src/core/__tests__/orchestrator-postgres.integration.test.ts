/**
 * Integration test: drives the orchestrator end-to-end against the real
 * Postgres database (via APP_DATABASE_URL). Skipped if the env var is missing
 * so the unit suite runs unmodified.
 *
 * Each run creates a fresh conversation under the seeded pilot tenant + user
 * and deletes the row in afterEach; if a run is interrupted, the leftover
 * row is harmless (no FK references downstream tables in this test path).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import {
  InProcessDecisionNotifier,
  OrchestratorCoreImpl,
} from '../orchestrator/orchestrator-core';
import { PostgresConversationStore } from '../orchestrator/postgres-store';
import { buildDefaultRegistry } from '../orchestrator/bootstrap-registry';
import { LocalAdapter } from '../../transport/local-adapter';
import { newTaskId } from '../ids';
import { closePool } from '../../db/pool';
import { systemRepos } from '../../repos';
import type { FieldDelta, PlannerDecision, UUID } from '../contracts';

const SUITE = process.env.APP_DATABASE_URL ? describe : describe.skip;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function fetchPilotIds(): Promise<{ tenantId: UUID; userId: UUID }> {
  // Use the superuser connection to read the seeded pilot tenant/user IDs.
  // Tenant SELECTs require app.tenant_id to be set under app_user, but we
  // need to discover the id first — bootstrap the lookup here as super.
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for the integration test bootstrap');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE name = 'Pilot Institution' LIMIT 1`,
    );
    if (tenant.rows.length === 0) throw new Error('Pilot Institution tenant is not seeded');
    const tenantId = tenant.rows[0].id;
    const user = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    if (user.rows.length === 0) throw new Error('Pilot user is not seeded');
    return { tenantId, userId: user.rows[0].id };
  } finally {
    await client.end();
  }
}

async function deleteConversation(conversationId: UUID): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  } finally {
    await client.end();
  }
}

SUITE('orchestrator + Postgres store (integration)', () => {
  let tenantId: UUID;
  let userId: UUID;
  const createdConversationIds: UUID[] = [];

  beforeAll(async () => {
    const ids = await fetchPilotIds();
    tenantId = ids.tenantId;
    userId = ids.userId;
  });

  afterEach(async () => {
    while (createdConversationIds.length > 0) {
      const id = createdConversationIds.pop()!;
      await deleteConversation(id);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('persists agent_states JSONB across the FieldDelta -> dispatch roundtrip', { timeout: 30_000 }, async () => {
    const registry = buildDefaultRegistry();
    const store = new PostgresConversationStore(registry.getFieldSchemas());

    let coreRef: OrchestratorCoreImpl | null = null;
    const transport = new LocalAdapter(registry, (taskId, state) => {
      void coreRef?.onTaskSettled(taskId, state);
    });
    const notifier = new InProcessDecisionNotifier();
    const core = new OrchestratorCoreImpl({
      store,
      registry,
      transport,
      notifier,
      newTaskId,
      agentTasksFor: (tid) => systemRepos({ id: tid }).agentTasks,
    });
    coreRef = core;

    const conversationId = randomUUID();
    createdConversationIds.push(conversationId);

    const observed: PlannerDecision[] = [];
    const subscription = notifier.subscribe(conversationId, (d) => {
      observed.push(d);
    });

    await core.startConversation(conversationId, tenantId, userId);

    const deltaName: FieldDelta = {
      conversationId,
      source: 'integration-test',
      timestamp: new Date().toISOString(),
      fields: {
        'name-agent': {
          business_name: { value: 'Sazón Andino', confidence: 1.0 },
        },
      },
    };
    await core.applyDelta(deltaName);

    const deltaProfile: FieldDelta = {
      conversationId,
      source: 'integration-test',
      timestamp: new Date().toISOString(),
      fields: {
        'name-agent': {
          business_profile: {
            value: 'Comida tradicional peruana lista para llevar.',
            confidence: 1.0,
          },
        },
      },
    };
    await core.applyDelta(deltaProfile);

    await flushMicrotasks();

    expect(observed.find((d) => d.kind === 'announce_dispatch')).toMatchObject({
      kind: 'announce_dispatch',
      agentId: 'name-agent',
    });
    expect(observed.find((d) => d.kind === 'announce_completion')).toMatchObject({
      kind: 'announce_completion',
      agentId: 'name-agent',
    });

    const snapshot = await core.getSnapshot(conversationId);
    expect(snapshot.tenantId).toBe(tenantId);
    expect(snapshot.agentStates['name-agent'].requiredFields.business_name.status).toBe('filled');
    expect(snapshot.agentStates['name-agent'].requiredFields.business_profile.status).toBe(
      'filled',
    );
    expect(snapshot.agentStates['name-agent'].lastDispatchedTaskId).toBeDefined();
    expect(snapshot.agentStates['name-agent'].iterationCount).toBe(1);

    // Read back through a fresh store instance to prove durability.
    const freshStore = new PostgresConversationStore(registry.getFieldSchemas());
    const reread = await freshStore.getOrCreate(conversationId, tenantId, userId);
    expect(reread.agentStates['name-agent'].requiredFields.business_name.status).toBe('filled');
    expect(reread.agentStates['name-agent'].iterationCount).toBe(1);

    // Prove the agent_task row was persisted with iteration_root_id = id and
    // terminal status set by onTaskSettled.
    const taskId = snapshot.agentStates['name-agent'].lastDispatchedTaskId!;
    const tasks = await systemRepos({ id: tenantId }).agentTasks.listByConversation(
      conversationId,
    );
    const dispatched = tasks.find((t) => t.id === taskId);
    expect(dispatched).toBeDefined();
    expect(dispatched!.iterationRootId).toBe(taskId);
    expect(dispatched!.iterationNumber).toBe(1);
    expect(dispatched!.status).toBe('completed');

    subscription.dispose();
  });
});
