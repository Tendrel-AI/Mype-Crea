/**
 * Integration test (KAN-28 / KAN-34): typed deliverable commands against real
 * PostgreSQL — the Postgres workflow store (guarded task insert, idempotency
 * key, pending-only cancel, iteration rows under the KAN-34 refinement CHECK)
 * and the production KAN-34 approval store (append-only history, persisted
 * stale marks feeding the state function). Skipped without APP_DATABASE_URL.
 * Run it only against a disposable database (docs/agents/testing.md).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { InProcessDecisionNotifier, OrchestratorCoreImpl } from '../orchestrator/orchestrator-core';
import { AgentRegistry } from '../orchestrator/agent-registry';
import { PostgresConversationStore } from '../orchestrator/postgres-store';
import { PostgresDeliverableWorkflowStore } from '../orchestrator/postgres-workflow';
import { createPostgresApprovalStore } from '../../repos/approval-store';
import { buildFixtureCard, fixtureEchoHandler } from './_fixtures/registry';
import { newTaskId } from '../ids';
import { closePool } from '../../db/pool';
import { repos, systemRepos } from '../../repos';
import type { A2AMessage, TaskState } from '../agent-types';
import type { DeliverableCommand, DeliverableStateView, UUID } from '../contracts';

const SUITE = process.env.APP_DATABASE_URL ? describe : describe.skip;
const AGENT_ID = 'logo-fixture-agent';
const LABEL_AGENT_ID = 'label-fixture-agent';

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

  async function harness(opts: { withDependentLabel?: boolean } = {}) {
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
    if (opts.withDependentLabel) {
      registry.register(
        buildFixtureCard({
          id: LABEL_AGENT_ID,
          required: [{ name: 'business_name' }],
          deliverableKind: 'label',
          dependsOn: ['logo'],
        }),
        fixtureEchoHandler,
        undefined,
      );
    }
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
      approvalsFor: (tid, uid) => createPostgresApprovalStore({ id: tid }, { id: uid }),
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
        ...(opts.withDependentLabel
          ? { [LABEL_AGENT_ID]: { business_name: { value: 'Sazón Andino', confidence: 1 } } }
          : {}),
      },
    });
    const viewOf = async (agentId: string): Promise<DeliverableStateView> =>
      (await core.getDeliverableStates(conversationId)).find((s) => s.agentId === agentId)!;
    const view = () => viewOf(AGENT_ID);
    const commandFor = async (agentId: string, partial: Record<string, unknown>, commandId: string = randomUUID()) => {
      const current = await viewOf(agentId);
      return core.executeCommand({
        commandId,
        conversationId,
        agentId,
        expectedState: current.state,
        stateToken: current.stateToken,
        ...partial,
      } as DeliverableCommand);
    };
    const command = (partial: Record<string, unknown>, commandId?: string) => commandFor(AGENT_ID, partial, commandId);
    const tasks = () => systemRepos({ id: tenantId }).agentTasks.listByConversation(conversationId);
    const settle = (taskId: string, state: TaskState) =>
      core.onTaskSettled(taskId, state);
    return { core, conversationId, messages, view, viewOf, command, commandFor, tasks, settle };
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

  it('Iterar and Reintentar insert iteration rows that satisfy the refinement CHECK; Aprobar replaces through the KAN-34 store with history', { timeout: 30_000 }, async () => {
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
    const retryRow = (await h.tasks()).find((t) => t.id === retry.taskId)!;
    expect(retryRow).toMatchObject({
      parentTaskId: iterate.taskId,
      iterationRootId: generated.taskId,
      iterationNumber: 3,
      iterationTrigger: 'failure',
    });
    // Reintentar carries no refinement (the brief only); the CHECK accepts it.
    expect(retryRow.requirementsSnapshot).not.toHaveProperty('refinement');
    expect(retryRow.requirementsSnapshot).toMatchObject({ business_name: 'Sazón Andino' });
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

    // KAN-34 append-only trail: the first approval and the replacement, nothing for the rejection.
    const history = await repos({ id: tenantId }, { id: userId }).approvals.listHistory(h.conversationId, 'logo');
    expect(history.map((r) => [r.deliverableId, r.replacedDeliverableId])).toEqual([
      [d1.id, null],
      [d2.id, d1.id],
    ]);
    // Re-approving the current deliverable is a replayed no-op: no new history row.
    expect(await h.command({ kind: 'approve', deliverableId: d2.id, expectedApprovedId: d2.id })).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await repos({ id: tenantId }, { id: userId }).approvals.listHistory(h.conversationId)).toHaveLength(2);
  });

  it('a content_policy failure offers Iterar and Reintentar; Iterar chains onto the failed task with a null anchor (KAN-58)', { timeout: 30_000 }, async () => {
    const h = await harness();
    const generated = await h.command({ kind: 'generate' });
    if (!generated.ok) throw new Error('expected ok');
    await h.settle(generated.taskId!, {
      status: 'failed',
      result: {
        status: 'failed',
        taskId: generated.taskId!,
        error: { kind: 'content_policy', message: 'synthetic' },
        completedAt: new Date().toISOString() as `${string}T${string}Z`,
      },
    });
    expect(await h.view()).toMatchObject({
      state: 'failed',
      lastFailure: { errorCategory: 'content_policy', retryable: false },
      allowedCommands: ['iterate', 'retry'],
    });
    const iterate = await h.command({ kind: 'iterate', observation: 'Sin la mascota, solo letras' });
    if (!iterate.ok) throw new Error(`iterate rejected: ${iterate.message}`);
    const row = (await h.tasks()).find((t) => t.id === iterate.taskId)!;
    expect(row).toMatchObject({
      parentTaskId: generated.taskId,
      iterationRootId: generated.taskId,
      iterationNumber: 2,
      iterationTrigger: 'failure',
    });
    // The CHECK and the guarded insert accept a failure iteration without an anchor.
    expect(row.requirementsSnapshot.refinement).toEqual({
      parameterChanges: {},
      observations: ['Sin la mascota, solo letras'],
      anchorDeliverableId: null,
    });
  });

  it('command iterations go through the shared guarded insert: parent, status, anchor and owner checks; numbering from the chain', { timeout: 30_000 }, async () => {
    const h = await harness();
    const other = await harness();
    const r = repos({ id: tenantId }, { id: userId });
    const tasksRepo = systemRepos({ id: tenantId }).agentTasks;
    const generated = await h.command({ kind: 'generate' });
    const otherGenerated = await other.command({ kind: 'generate' });
    if (!generated.ok || !otherGenerated.ok) throw new Error('expected ok');
    await h.settle(generated.taskId!, completed(generated.taskId!));
    await other.settle(otherGenerated.taskId!, completed(otherGenerated.taskId!));
    const d1 = await r.deliverables.insert({
      conversationId: h.conversationId, agentTaskId: generated.taskId!, kind: 'logo', contentUrl: 'https://cdn.test/1.png',
    });
    const foreignAnchor = await r.deliverables.insert({
      conversationId: other.conversationId, agentTaskId: otherGenerated.taskId!, kind: 'logo', contentUrl: 'https://cdn.test/x.png',
    });
    const refinement = (anchorDeliverableId: string | null, observations = ['Más azul']) => ({
      parameterChanges: {}, observations, anchorDeliverableId,
    });
    const commandIteration = (over: {
      parentTaskId?: string; trigger?: 'user_regenerate' | 'failure'; agentId?: string;
      snapshot?: Record<string, unknown>; owner?: { id: UUID } | undefined;
    }) =>
      tasksRepo.insertCommandTask({
        conversationId: h.conversationId,
        agentId: over.agentId ?? AGENT_ID,
        agentCardVersion: '0.0.1',
        idempotencyKey: randomUUID(),
        requirementsSnapshot: over.snapshot ?? { business_name: 'Sazón Andino', refinement: refinement(d1.id) },
        owner: 'owner' in over ? over.owner : { id: userId },
        iteration: { parentTaskId: (over.parentTaskId ?? generated.taskId!) as never, trigger: over.trigger ?? 'user_regenerate' },
      });
    const refused = (detail: string) => ({ ok: false, reason: 'invalid_parent', detail });

    // Parent of another conversation, of another agent, or without the owner bound.
    expect(await commandIteration({ parentTaskId: otherGenerated.taskId! })).toEqual(refused('parent_not_found'));
    expect(await commandIteration({ agentId: 'another-agent' })).toEqual(refused('parent_not_found'));
    expect(await commandIteration({ owner: undefined })).toEqual(refused('parent_not_found'));
    // Reintentar needs a failed parent; the anchor must be a deliverable of the parent.
    expect(await commandIteration({ trigger: 'failure', snapshot: { business_name: 'Sazón Andino' } }))
      .toEqual(refused('parent_not_failed'));
    expect(await commandIteration({ snapshot: { refinement: refinement(foreignAnchor.id) } }))
      .toEqual(refused('anchor_not_in_parent'));
    // The single refinement rule runs before the insert (the DB CHECK is the backstop).
    await expect(commandIteration({ snapshot: { refinement: refinement(d1.id, Array(6).fill('a')) } }))
      .rejects.toMatchObject({ name: 'RefinementValidationError', code: 'too_many_observations' });
    expect(await h.tasks()).toHaveLength(1);

    // The workflow store ignores caller-supplied numbering: root and number come from the chain.
    const store = new PostgresDeliverableWorkflowStore(tenantId, userId);
    const created = await store.createTask({
      conversationId: h.conversationId,
      agentId: AGENT_ID,
      agentCardVersion: '0.0.1',
      commandId: randomUUID(),
      requirementsSnapshot: { business_name: 'Sazón Andino', refinement: refinement(d1.id) },
      iteration: {
        parentTaskId: generated.taskId!,
        iterationRootId: randomUUID() as never,
        iterationNumber: 99,
        trigger: 'user_regenerate',
      },
    });
    if (!created.ok) throw new Error(`expected ok, got ${created.reason}`);
    expect(created.task).toMatchObject({
      parentTaskId: generated.taskId,
      iterationRootId: generated.taskId,
      iterationNumber: 2,
      iterationTrigger: 'user_regenerate',
    });
    // A stale parent through the port is reported as `parent_unavailable` (the handler answers `stale`).
    await tasksRepo.cancelPending(h.conversationId, created.task.id);
    expect(
      await store.createTask({
        conversationId: h.conversationId, agentId: AGENT_ID, agentCardVersion: '0.0.1', commandId: randomUUID(),
        requirementsSnapshot: {},
        iteration: { parentTaskId: otherGenerated.taskId!, iterationRootId: otherGenerated.taskId!, iterationNumber: 2, trigger: 'user_regenerate' },
      }),
    ).toEqual({ ok: false, reason: 'parent_unavailable' });
  });

  it('persisted stale marks reach the state function; replacing an upstream approval marks approved dependents', { timeout: 30_000 }, async () => {
    const h = await harness({ withDependentLabel: true });
    const r = repos({ id: tenantId }, { id: userId });
    const candidate = async (agentId: string, kind: 'logo' | 'label', partial: Record<string, unknown>, url: string) => {
      const created = await h.commandFor(agentId, partial);
      if (!created.ok) throw new Error(`${agentId} ${String(partial.kind)} rejected: ${created.message}`);
      await h.settle(created.taskId!, completed(created.taskId!));
      return r.deliverables.insert({ conversationId: h.conversationId, agentTaskId: created.taskId!, kind, contentUrl: url });
    };

    // The label is blocked until the logo is approved.
    expect(await h.viewOf(LABEL_AGENT_ID)).toMatchObject({ state: 'blocked', allowedCommands: [] });
    const logo1 = await candidate(AGENT_ID, 'logo', { kind: 'generate' }, 'https://cdn.test/logo-1.png');
    expect(await h.command({ kind: 'approve', deliverableId: logo1.id, expectedApprovedId: null })).toMatchObject({ ok: true });
    const label1 = await candidate(LABEL_AGENT_ID, 'label', { kind: 'generate' }, 'https://cdn.test/label-1.png');
    expect(
      await h.commandFor(LABEL_AGENT_ID, { kind: 'approve', deliverableId: label1.id, expectedApprovedId: null }),
    ).toMatchObject({ ok: true });
    expect(await h.viewOf(LABEL_AGENT_ID)).toMatchObject({ state: 'approved', approvedDeliverableId: label1.id });

    // Approving the logo first and the label later never makes the label «obsoleto» by itself
    // (no timestamp comparison, owner decision 2026-10-25). A mark alone does: the state
    // function reads only the explicit KAN-34 marks.
    expect(await h.viewOf(LABEL_AGENT_ID)).toMatchObject({ stale: false });
    await r.approvals.markStale({ conversationId: h.conversationId, deliverableKinds: ['label'] });
    expect((await r.approvals.listStale(h.conversationId)).map((m) => m.deliverableKind)).toEqual(['label']);
    // «obsoleto» is an overlay on `approved`; it also offers Generar again (never automatic).
    expect(await h.viewOf(LABEL_AGENT_ID)).toMatchObject({
      state: 'approved',
      stale: true,
      approvedDeliverableId: label1.id,
      allowedCommands: ['generate', 'iterate'],
    });

    // Approving another label candidate clears the mark (newer approval event).
    const label2 = await candidate(
      LABEL_AGENT_ID,
      'label',
      { kind: 'iterate', deliverableId: label1.id, observation: 'Más contraste' },
      'https://cdn.test/label-2.png',
    );
    expect(
      await h.commandFor(LABEL_AGENT_ID, { kind: 'approve', deliverableId: label2.id, expectedApprovedId: label1.id }),
    ).toMatchObject({ ok: true });
    expect(await r.approvals.listStale(h.conversationId)).toEqual([]);
    expect(await h.viewOf(LABEL_AGENT_ID)).toMatchObject({ state: 'approved', stale: false, approvedDeliverableId: label2.id });

    // Replacing the logo approval writes a persisted mark for the approved dependent (RF-07) in
    // the approval's own transaction; nothing is regenerated.
    const tasksBefore = (await h.tasks()).length;
    const logo2 = await candidate(
      AGENT_ID,
      'logo',
      { kind: 'iterate', deliverableId: logo1.id, observation: 'Más azul' },
      'https://cdn.test/logo-2.png',
    );
    expect(await h.command({ kind: 'approve', deliverableId: logo2.id, expectedApprovedId: logo1.id })).toMatchObject({ ok: true });
    expect((await r.approvals.listStale(h.conversationId)).map((m) => m.deliverableKind)).toEqual(['label']);
    expect(await h.viewOf(LABEL_AGENT_ID)).toMatchObject({ state: 'approved', stale: true, approvedDeliverableId: label2.id });
    expect((await h.tasks()).length).toBe(tasksBefore + 1);
  });
});
