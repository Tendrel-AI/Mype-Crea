/**
 * Integration test (KAN-28): typed deliverable commands against real
 * PostgreSQL — the Postgres workflow store (guarded task insert, idempotency
 * key, pending-only cancel, iteration rows) and the TEMPORARY selected_at
 * approval adapter. Skipped without APP_DATABASE_URL. Run it only against a
 * disposable database (docs/agents/testing.md).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { InProcessDecisionNotifier, OrchestratorCoreImpl } from '../orchestrator/orchestrator-core';
import { AgentRegistry } from '../orchestrator/agent-registry';
import { PostgresConversationStore } from '../orchestrator/postgres-store';
import { PostgresDeliverableWorkflowStore } from '../orchestrator/postgres-workflow';
import { SelectedAtApprovalStore } from '../orchestrator/selected-at-approval-store';
import { buildFixtureCard, fixtureEchoHandler } from './_fixtures/registry';
import { newTaskId } from '../ids';
import { closePool } from '../../db/pool';
import { repos, systemRepos } from '../../repos';
import type { A2AMessage, TaskState } from '../agent-types';
import type { DeliverableCommand, DeliverableStateView, UUID } from '../contracts';

const SUITE = process.env.APP_DATABASE_URL ? describe : describe.skip;
const AGENT_ID = 'logo-fixture-agent';

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set for the integration test bootstrap');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

SUITE('deliverable commands + Postgres (integration)', () => {
  let tenantId: UUID;
  let userId: UUID;
  const created: UUID[] = [];

  beforeAll(async () => {
    const [tenant] = await ownerQuery<{ id: string }>(`SELECT id FROM tenants WHERE name = 'Pilot Institution' LIMIT 1`);
    if (!tenant) throw new Error('Pilot Institution tenant is not seeded');
    tenantId = tenant.id;
    const [user] = await ownerQuery<{ id: string }>(
      `SELECT id FROM users WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
      [tenantId],
    );
    if (!user) throw new Error('Pilot user is not seeded');
    userId = user.id;
  });

  afterEach(async () => {
    while (created.length > 0) {
      await ownerQuery(`DELETE FROM conversations WHERE id = $1`, [created.pop()!]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function harness() {
    const registry = new AgentRegistry();
    registry.register(
      buildFixtureCard({
        id: AGENT_ID,
        required: [{ name: 'business_name' }, { name: 'business_profile' }],
        deliverableKind: 'logo',
      }),
      fixtureEchoHandler,
      undefined,
    );
    const messages: A2AMessage[] = [];
    const core = new OrchestratorCoreImpl({
      store: new PostgresConversationStore(registry.getFieldSchemas()),
      registry,
      // Controlled transport: tasks stay pending until the test settles them.
      transport: {
        dispatch: async (message) => {
          messages.push(message);
          return { taskId: message.taskId };
        },
        getResult: async (): Promise<TaskState> => ({ status: 'pending' }),
      },
      notifier: new InProcessDecisionNotifier(),
      newTaskId,
      workflowFor: (tid, uid) => new PostgresDeliverableWorkflowStore(tid, uid),
      approvalsFor: (tid, uid) => new SelectedAtApprovalStore(tid, uid),
    });
    const conversationId = randomUUID();
    created.push(conversationId);
    await core.startConversation(conversationId, tenantId, userId);
    await core.applyDelta({
      conversationId,
      source: 'integration-test',
      timestamp: new Date().toISOString(),
      fields: {
        [AGENT_ID]: {
          business_name: { value: 'Sazón Andino', confidence: 1 },
          business_profile: { value: 'Comida peruana', confidence: 1 },
        },
      },
    });
    const view = async (): Promise<DeliverableStateView> => (await core.getDeliverableStates(conversationId))[0];
    const command = async (partial: Record<string, unknown>, commandId: string = randomUUID()) => {
      const current = await view();
      return core.executeCommand({
        commandId,
        conversationId,
        agentId: AGENT_ID,
        expectedState: current.state,
        stateToken: current.stateToken,
        ...partial,
      } as DeliverableCommand);
    };
    const tasks = () => systemRepos({ id: tenantId }).agentTasks.listByConversation(conversationId);
    const settle = (taskId: string, state: TaskState) =>
      core.onTaskSettled(taskId, state);
    return { core, conversationId, messages, view, command, tasks, settle };
  }

  const completed = (taskId: string): TaskState => ({
    status: 'completed',
    result: {
      status: 'completed',
      taskId,
      artifacts: [{ kind: 'image', url: 'https://cdn.test/logo.png' }],
      completedAt: new Date().toISOString() as `${string}T${string}Z`,
    },
  });

  it('Generar is idempotent by command id, guarded against a second active task, and Cancelar works only while pending', { timeout: 30_000 }, async () => {
    const h = await harness();
    const commandId = randomUUID();
    const first = await h.command({ kind: 'generate' }, commandId);
    expect(first).toMatchObject({ ok: true, replayed: false });
    if (!first.ok) throw new Error('expected ok');

    // Same command id: no second row, no second dispatch (durable replay).
    const replay = await h.core.executeCommand({
      kind: 'generate',
      commandId,
      conversationId: h.conversationId,
      agentId: AGENT_ID,
      expectedState: 'enabled',
      stateToken: 'whatever',
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, taskId: first.taskId });
    expect(await h.tasks()).toHaveLength(1);
    expect(h.messages).toHaveLength(1);

    // The repository guard rejects a second active task even past validation.
    const guarded = await systemRepos({ id: tenantId }).agentTasks.insertCommandTask({
      conversationId: h.conversationId,
      agentId: AGENT_ID,
      agentCardVersion: '0.0.1',
      idempotencyKey: randomUUID(),
      requirementsSnapshot: {},
    });
    expect(guarded).toEqual({ ok: false, reason: 'active_task_exists' });

    // Cancelar while pending.
    const pending = await h.view();
    expect(pending).toMatchObject({ state: 'generating', allowedCommands: ['cancel'] });
    const cancel = await h.command({ kind: 'cancel', taskId: first.taskId });
    expect(cancel).toMatchObject({ ok: true });
    expect((await h.tasks())[0].status).toBe('canceled');
    expect(await h.view()).toMatchObject({ state: 'enabled', allowedCommands: ['generate'] });

    // A late result for the canceled task never overwrites `canceled`.
    await h.settle(first.taskId!, completed(first.taskId!));
    expect((await h.tasks())[0].status).toBe('canceled');

    // Once claimed (in_progress), Cancelar is no longer offered nor accepted.
    const second = await h.command({ kind: 'generate' });
    if (!second.ok) throw new Error('expected ok');
    await systemRepos({ id: tenantId }).agentTasks.claimById(second.taskId!);
    expect(await h.view()).toMatchObject({ state: 'generating', allowedCommands: [] });
    expect(await h.command({ kind: 'cancel', taskId: second.taskId })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('Iterar and Reintentar insert iteration rows with the right trigger and refinement; Aprobar replaces through selected_at', { timeout: 30_000 }, async () => {
    const h = await harness();
    const generated = await h.command({ kind: 'generate' });
    if (!generated.ok) throw new Error('expected ok');
    await h.settle(generated.taskId!, completed(generated.taskId!));
    // The worker persists deliverables; stand in for it.
    const d1 = await repos({ id: tenantId }, { id: userId }).deliverables.insert({
      conversationId: h.conversationId,
      agentTaskId: generated.taskId!,
      kind: 'logo',
      contentUrl: 'https://cdn.test/1.png',
    });
    expect(await h.view()).toMatchObject({ state: 'in_review', allowedCommands: ['iterate', 'approve'] });

    const iterate = await h.command({ kind: 'iterate', deliverableId: d1.id, observation: '  Hazlo más azul  ' });
    if (!iterate.ok) throw new Error(`iterate rejected: ${iterate.message}`);
    const iterationRow = (await h.tasks()).find((t) => t.id === iterate.taskId)!;
    expect(iterationRow).toMatchObject({
      parentTaskId: generated.taskId,
      iterationRootId: generated.taskId,
      iterationNumber: 2,
      iterationTrigger: 'user_regenerate',
    });
    expect(iterationRow.requirementsSnapshot.refinement).toEqual({
      parameterChanges: {},
      observations: ['Hazlo más azul'],
      anchorDeliverableId: d1.id,
    });
    expect(h.messages.at(-1)?.iteration).toMatchObject({ parentTaskId: generated.taskId, observations: ['Hazlo más azul'] });
    expect(h.messages.at(-1)?.requirements).not.toHaveProperty('refinement');

    // The iteration fails transiently -> Reintentar -> iteration 3, trigger failure.
    await h.settle(iterate.taskId!, {
      status: 'failed',
      result: {
        status: 'failed',
        taskId: iterate.taskId!,
        error: { kind: 'timeout', message: 'synthetic' },
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    });
    expect(await h.view()).toMatchObject({ state: 'failed', allowedCommands: ['retry'] });
    const retry = await h.command({ kind: 'retry', failedTaskId: iterate.taskId });
    if (!retry.ok) throw new Error('expected ok');
    expect((await h.tasks()).find((t) => t.id === retry.taskId)).toMatchObject({
      parentTaskId: iterate.taskId,
      iterationNumber: 3,
      iterationTrigger: 'failure',
    });
    await h.settle(retry.taskId!, completed(retry.taskId!));
    const d2 = await repos({ id: tenantId }, { id: userId }).deliverables.insert({
      conversationId: h.conversationId,
      agentTaskId: retry.taskId!,
      kind: 'logo',
      contentUrl: 'https://cdn.test/2.png',
    });

    // Aprobar d1, then replace with d2; a stale expectedApprovedId is rejected.
    const approve1 = await h.command({ kind: 'approve', deliverableId: d1.id, expectedApprovedId: null });
    expect(approve1).toMatchObject({ ok: true });
    const staleApprove = await h.command({ kind: 'approve', deliverableId: d2.id, expectedApprovedId: null });
    expect(staleApprove).toMatchObject({ ok: false, reason: 'stale' });
    const approve2 = await h.command({ kind: 'approve', deliverableId: d2.id, expectedApprovedId: d1.id });
    expect(approve2).toMatchObject({ ok: true });

    const rows = await repos({ id: tenantId }, { id: userId }).deliverables.listByConversation(h.conversationId);
    expect(rows.find((r) => r.id === d1.id)).toMatchObject({ selectedAt: null, supersededBy: d2.id });
    expect(rows.find((r) => r.id === d2.id)?.selectedAt).not.toBeNull();
    expect(await h.view()).toMatchObject({ state: 'approved', approvedDeliverableId: d2.id });
  });
});
