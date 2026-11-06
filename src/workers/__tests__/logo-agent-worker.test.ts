/**
 * Unit tests for the logo-agent worker. The worker subscribes to the
 * Redis dispatch channel, claims the agent_tasks row by id, runs the
 * registered logo-agent handler, and hands the resulting TaskState to
 * the orchestrator's onTaskSettled.
 *
 * Uses shared helpers from `_helpers.ts` so the worker plumbing
 * (FakeSubscriber, AgentTaskRow factory, WorkerContext defaults) lives
 * in one place and can be reused by tagline/label/social worker tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { NAME_WORKER, TAGLINE_WORKER, startAgentWorker, startLogoAgentWorker } from '../agent-worker';
import { channelForAgent, dispatchWakeUp, type DispatchNotification } from '../../transport/redis-queue-adapter';
import {
  AgentRegistry,
  type AgentCard,
} from '../../core/orchestrator/agent-registry';
import logoCard from '../../../agents/logo-agent/agent-card.json';
import nameCard from '../../../agents/name-agent/agent-card.json';
import taglineCard from '../../../agents/tagline-agent/agent-card.json';
import type {
  A2AMessage,
  AgentHandler,
  TaskState,
} from '../../core/agent-types';
import type { AgentId, TaskId } from '../../core/contracts';
import { TaskError } from '../../core/task-errors';
import { InMemoryObjectStorage } from '../../services/storage/memory-storage';
import { storeArtifactImages } from '../../services/storage/artifact-store';
import { StorageConfigError } from '../../services/storage/types';
import {
  buildAgentTaskRow,
  buildWorkerTestContext,
  FakeSubscriber,
  flushMicrotasks,
} from './_helpers';

/** A dispatch wake-up as every publisher writes it (through the notification contract). */
const wakeUp = (payload: DispatchNotification): string => dispatchWakeUp(payload).message;

describe('logo-agent worker', () => {
  it.each([
    ['not JSON', 'not-json'],
    ['a pre-contract payload without version or kind', JSON.stringify({
      taskId: '77777777-7777-7777-7777-777777777777',
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'logo-agent',
    })],
    ['another notification kind', JSON.stringify({ v: 1, kind: 'task_processing', taskId: 't', agentId: 'a', conversationId: 'c', claimedAt: 'now' })],
    ['a dispatch without tenantId', JSON.stringify({ v: 1, kind: 'task_dispatch', taskId: 't', agentId: 'logo-agent' })],
  ])('rejects a wake-up that is %s without reading or claiming anything (KAN-58)', async (_label, raw) => {
    const subscriber = new FakeSubscriber();
    const findById = vi.fn();
    const claimById = vi.fn();
    await startLogoAgentWorker(
      buildWorkerTestContext({
        subscriber,
        systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      }),
    );
    subscriber.emitMessage(channelForAgent('logo-agent' as AgentId), raw);
    await flushMicrotasks();
    expect(findById).not.toHaveBeenCalled();
    expect(claimById).not.toHaveBeenCalled();
  });

  it('subscribes to the logo-agent dispatch channel on start', async () => {
    const subscriber = new FakeSubscriber();
    const ctx = buildWorkerTestContext({ subscriber });

    const handle = await startLogoAgentWorker(ctx);

    expect(subscriber.subscribed).toContain(
      channelForAgent('logo-agent' as AgentId),
    );

    await handle.stop();
    expect(subscriber.unsubscribed).toContain(
      channelForAgent('logo-agent' as AgentId),
    );
  });

  it('claims the row, runs the handler, and forwards the completed state to onTaskSettled', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();

    const fakeHandler: AgentHandler<undefined> = vi.fn(
      async (message: A2AMessage) => ({
        status: 'completed' as const,
        taskId: message.taskId,
        artifacts: [
          {
            kind: 'image',
            url: 'https://example.test/logo.png',
            metadata: { provider: 'fake', model: 'fake' },
          },
        ],
        completedAt: '2026-05-04T00:00:01Z',
      }),
    );
    registry.register(logoCard as AgentCard, fakeHandler, undefined);

    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const onTaskSettled = vi.fn();

    await startLogoAgentWorker(
      buildWorkerTestContext({
        subscriber,
        registry,
        systemReposFor: () =>
          ({
            agentTasks: { findById, claimById } as never,
            llmCalls: {} as never,
          }),
        onTaskSettled,
      }),
    );

    subscriber.emitMessage(
      channelForAgent('logo-agent' as AgentId),
      wakeUp({
        taskId: row.id,
        tenantId: '66666666-6666-6666-6666-666666666666',
        agentId: 'logo-agent',
      }),
    );

    await flushMicrotasks();
    await flushMicrotasks();

    expect(claimById).toHaveBeenCalledWith(row.id, 'logo-agent');
    expect(fakeHandler).toHaveBeenCalledTimes(1);

    const handlerCall = (fakeHandler as ReturnType<typeof vi.fn>).mock.calls[0]
      ?.[0] as A2AMessage;
    expect(handlerCall.taskId).toBe(row.id);
    expect(handlerCall.agentId).toBe('logo-agent');
    expect(handlerCall.requirements).toEqual(row.requirementsSnapshot);

    expect(onTaskSettled).toHaveBeenCalledTimes(1);
    const [settledTaskId, settledState] = (
      onTaskSettled as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [TaskId, TaskState];
    expect(settledTaskId).toBe(row.id);
    expect(settledState.status).toBe('completed');
  });

  it('atomically settles artifacts and outbox before awaiting trusted core settlement', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const artifacts = [{ kind: 'image', url: 'https://example.test/logo.png' }];
    registry.register(logoCard as AgentCard, vi.fn(async (message: A2AMessage) => ({
      status: 'completed' as const,
      taskId: message.taskId,
      artifacts,
      completedAt: '2026-05-04T00:00:01Z',
    })), undefined);
    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const settleTaskAndEnqueue = vi.fn(async () => ({ deliverableIds: ['99999999-9999-4999-8999-999999999999'] }));
    const deliverablesFor = vi.fn();
    const onTaskSettled = vi.fn(async () => undefined);

    await startLogoAgentWorker(buildWorkerTestContext({
      subscriber,
      registry,
      systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      settleTaskFor: () => ({ settleTaskAndEnqueue } as never),
      deliverablesFor,
      onTaskSettled,
    }));
    subscriber.emitMessage(channelForAgent('logo-agent' as AgentId), wakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'logo-agent',
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: row.conversationId,
      taskId: row.id,
      state: 'completed',
      deliverableKind: 'logo',
      artifacts,
    }));
    expect(deliverablesFor).not.toHaveBeenCalled();
    expect(onTaskSettled).toHaveBeenCalledWith(row.id, expect.objectContaining({ status: 'completed' }),
      ['99999999-9999-4999-8999-999999999999'], expect.objectContaining({ durableSettlement: true, ownerUserId: '22222222-2222-2222-2222-222222222222' }));
  });

  it('the name worker (KAN-31) settles five inline text candidates as business_name deliverables', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const artifacts = ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco'].map((inline) => ({ kind: 'text', inline, metadata: { rationale: `Razón de ${inline}.` } }));
    registry.register(nameCard as AgentCard, vi.fn(async (message: A2AMessage) => ({
      status: 'completed' as const,
      taskId: message.taskId,
      artifacts,
      completedAt: '2026-05-04T00:00:01Z',
    })), undefined);
    const row = buildAgentTaskRow({ agentId: 'name-agent', requirementsSnapshot: { business_category: 'alimentos', style_keywords: 'rústico' } });
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const settleTaskAndEnqueue = vi.fn(async () => ({ deliverableIds: [] }));
    const storeArtifacts = vi.fn(async ({ artifacts: stored }: { artifacts: unknown[] }) => stored);

    await startAgentWorker(buildWorkerTestContext({
      subscriber,
      registry,
      systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      settleTaskFor: () => ({ settleTaskAndEnqueue } as never),
      storeArtifacts: storeArtifacts as never,
    }), NAME_WORKER);
    expect(subscriber.subscribed).toEqual([channelForAgent('name-agent' as AgentId)]);
    subscriber.emitMessage(channelForAgent('name-agent' as AgentId), wakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'name-agent',
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(claimById).toHaveBeenCalledWith(row.id, 'name-agent');
    expect(settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: row.id,
      state: 'completed',
      deliverableKind: 'business_name',
      artifacts,
    }));
  });

  it('the tagline worker (KAN-32) hands the approved name to the handler as `upstream` and settles tagline deliverables', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const artifacts = ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco'].map((inline) => ({ kind: 'text', inline }));
    const handler = vi.fn(async (message: A2AMessage) => ({
      status: 'completed' as const,
      taskId: message.taskId,
      artifacts,
      completedAt: '2026-05-04T00:00:01Z',
    }));
    registry.register(taglineCard as AgentCard, handler, undefined);
    const nameId = '55555555-5555-4555-8555-555555555555';
    const row = buildAgentTaskRow({
      agentId: 'tagline-agent',
      requirementsSnapshot: {
        business_category: 'alimentos',
        style_keywords: 'rústico',
        upstream_approvals: { business_name: nameId },
        upstream_inputs: { business_name: { deliverableId: nameId, value: 'Dulce Andino' } },
      },
    });
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const settleTaskAndEnqueue = vi.fn(async () => ({ deliverableIds: [] }));

    await startAgentWorker(buildWorkerTestContext({
      subscriber,
      registry,
      systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      settleTaskFor: () => ({ settleTaskAndEnqueue } as never),
      storeArtifacts: (async ({ artifacts: stored }: { artifacts: unknown[] }) => stored) as never,
    }), TAGLINE_WORKER);
    subscriber.emitMessage(channelForAgent('tagline-agent' as AgentId), wakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'tagline-agent',
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      requirements: { business_category: 'alimentos', style_keywords: 'rústico' },
      upstream: { business_name: { deliverableId: nameId, value: 'Dulce Andino' } },
    }), undefined);
    expect(settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed', deliverableKind: 'tagline', artifacts }));
  });

  it('skips when claimById returns null (already in_progress or completed)', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const fakeHandler = vi.fn();
    registry.register(logoCard as AgentCard, fakeHandler as never, undefined);

    const findById = vi.fn(async () =>
      buildAgentTaskRow({ id: '77777777-7777-7777-7777-777777777777' as TaskId, status: 'in_progress' }),
    );
    const claimById = vi.fn(async () => null);
    const onTaskSettled = vi.fn();

    await startLogoAgentWorker(
      buildWorkerTestContext({
        subscriber,
        registry,
        systemReposFor: () =>
          ({
            agentTasks: { findById, claimById } as never,
            llmCalls: {} as never,
          }),
        onTaskSettled,
      }),
    );

    subscriber.emitMessage(
      channelForAgent('logo-agent' as AgentId),
      wakeUp({
        taskId: '77777777-7777-7777-7777-777777777777',
        tenantId: '66666666-6666-6666-6666-666666666666',
        agentId: 'logo-agent',
      }),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(claimById).toHaveBeenCalled();
    expect(fakeHandler).not.toHaveBeenCalled();
    expect(onTaskSettled).not.toHaveBeenCalled();
  });

  it('does not claim a non-logo task delivered on the logo channel', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const fakeHandler = vi.fn();
    registry.register(logoCard as AgentCard, fakeHandler as never, undefined);
    const row = buildAgentTaskRow({ agentId: 'tagline-agent' as AgentId, status: 'pending' });
    const findById = vi.fn(async () => row);
    const claimById = vi.fn(async () => ({ ...row, status: 'in_progress' as const }));
    const onTaskSettled = vi.fn();

    await startLogoAgentWorker(
      buildWorkerTestContext({
        subscriber,
        registry,
        systemReposFor: () =>
          ({
            agentTasks: { findById, claimById } as never,
            llmCalls: {} as never,
          }),
        onTaskSettled,
      }),
    );

    subscriber.emitMessage(
      channelForAgent('logo-agent' as AgentId),
      wakeUp({
        taskId: row.id,
        tenantId: '66666666-6666-6666-6666-666666666666',
        agentId: 'logo-agent',
      }),
    );
    await flushMicrotasks();

    // The row stays pending for its owner: never claimed, run, or settled here.
    expect(findById).toHaveBeenCalledWith(row.id);
    expect(claimById).not.toHaveBeenCalled();
    expect(fakeHandler).not.toHaveBeenCalled();
    expect(onTaskSettled).not.toHaveBeenCalled();
  });

  it('awaits async onTaskSettled before finishing message handling', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const fakeHandler: AgentHandler<undefined> = vi.fn(async (message: A2AMessage) => ({
      status: 'completed' as const,
      taskId: message.taskId,
      artifacts: [],
      completedAt: '2026-05-04T00:00:01Z',
    }));
    registry.register(logoCard as AgentCard, fakeHandler, undefined);

    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    let releaseSettlement!: () => void;
    let settlementFinished = false;
    const settlementGate = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const onTaskSettled = vi.fn(async () => {
      await settlementGate;
      settlementFinished = true;
    });

    await startLogoAgentWorker(
      buildWorkerTestContext({
        subscriber,
        registry,
        systemReposFor: () =>
          ({
            agentTasks: { findById, claimById } as never,
            llmCalls: {} as never,
          }),
        onTaskSettled,
      }),
    );

    const onMessage = subscriber.listeners('message')[0] as (
      channel: string,
      payload: string,
    ) => Promise<void>;
    let handlingFinished = false;
    const handling = onMessage(
      channelForAgent('logo-agent' as AgentId),
      wakeUp({
        taskId: row.id,
        tenantId: '66666666-6666-6666-6666-666666666666',
        agentId: 'logo-agent',
      }),
    ).then(() => {
      handlingFinished = true;
    });

    try {
      await flushMicrotasks();
      expect(onTaskSettled).toHaveBeenCalledTimes(1);
      expect(handlingFinished).toBe(false);
      releaseSettlement();
      await handling;
      expect(settlementFinished).toBe(true);
      expect(handlingFinished).toBe(true);
    } finally {
      // Release the fake async callback even when the expected-failure
      // assertion fires, so the worker cannot leave a pending promise behind.
      releaseSettlement();
      await handling;
    }
  });

  it('forwards a failed TaskState when the handler throws', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const failingHandler: AgentHandler<undefined> = vi.fn(async () => {
      throw new Error('image provider down');
    });
    registry.register(logoCard as AgentCard, failingHandler, undefined);

    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const onTaskSettled = vi.fn();

    await startLogoAgentWorker(
      buildWorkerTestContext({
        subscriber,
        registry,
        systemReposFor: () =>
          ({
            agentTasks: { findById, claimById } as never,
            llmCalls: {} as never,
          }),
        onTaskSettled,
      }),
    );

    subscriber.emitMessage(
      channelForAgent('logo-agent' as AgentId),
      wakeUp({
        taskId: row.id,
        tenantId: '66666666-6666-6666-6666-666666666666',
        agentId: 'logo-agent',
      }),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onTaskSettled).toHaveBeenCalledTimes(1);
    const [, state] = (onTaskSettled as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(state.status).toBe('failed');
    expect(state.result.error.message).toBe('image provider down');
  });
  it('keeps the typed kind when the handler throws a TaskError (KAN-58)', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    registry.register(logoCard as AgentCard, vi.fn(async () => {
      throw new TaskError('rate_limited', 'provider throttled');
    }), undefined);
    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const onTaskSettled = vi.fn();

    await startLogoAgentWorker(buildWorkerTestContext({
      subscriber,
      registry,
      systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      onTaskSettled,
    }));
    subscriber.emitMessage(channelForAgent('logo-agent' as AgentId), wakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'logo-agent',
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    const [, state] = (onTaskSettled as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(state.result.error).toEqual({ kind: 'rate_limited', message: 'provider throttled' });
  });

  it('durably settles a failure with its error detail and classified category (KAN-58)', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    registry.register(logoCard as AgentCard, vi.fn(async (message: A2AMessage) => ({
      status: 'failed' as const,
      taskId: message.taskId,
      error: { kind: 'content_policy', message: 'blocked by provider safety filter' },
      completedAt: '2026-05-04T00:00:01Z',
    })), undefined);
    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const settleTaskAndEnqueue = vi.fn(async () => ({ deliverableIds: [] }));
    const onTaskSettled = vi.fn(async () => undefined);

    await startLogoAgentWorker(buildWorkerTestContext({
      subscriber,
      registry,
      systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      settleTaskFor: () => ({ settleTaskAndEnqueue } as never),
      onTaskSettled,
    }));
    subscriber.emitMessage(channelForAgent('logo-agent' as AgentId), wakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'logo-agent',
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: row.id,
      state: 'failed',
      artifacts: [],
      error: { kind: 'content_policy', message: 'blocked by provider safety filter' },
      errorCategory: 'content_policy',
    }));
    expect(onTaskSettled).toHaveBeenCalledWith(row.id, expect.objectContaining({ status: 'failed' }), [],
      expect.objectContaining({ durableSettlement: true }));
  });

  it('contains a failing durable settlement and does not announce it', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    registry.register(logoCard as AgentCard, vi.fn(async (message: A2AMessage) => ({
      status: 'completed' as const,
      taskId: message.taskId,
      artifacts: [],
      completedAt: '2026-05-04T00:00:01Z',
    })), undefined);
    const row = buildAgentTaskRow();
    const findById = vi.fn(async () => ({ ...row, status: 'pending' as const }));
    const claimById = vi.fn(async () => row);
    const settleTaskAndEnqueue = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    const onTaskSettled = vi.fn(async () => undefined);

    await startLogoAgentWorker(buildWorkerTestContext({
      subscriber,
      registry,
      systemReposFor: () => ({ agentTasks: { findById, claimById } as never, llmCalls: {} as never }),
      settleTaskFor: () => ({ settleTaskAndEnqueue } as never),
      onTaskSettled,
    }));
    const onMessage = subscriber.listeners('message')[0] as (channel: string, payload: string) => Promise<void>;
    await expect(onMessage(channelForAgent('logo-agent' as AgentId), wakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'logo-agent',
    }))).resolves.toBeUndefined();

    expect(settleTaskAndEnqueue).toHaveBeenCalledTimes(1);
    expect(onTaskSettled).not.toHaveBeenCalled();
  });

  describe('private asset storage (KAN-52)', () => {
    const TENANT = '66666666-6666-4666-8666-666666666666';
    const PROVIDER_URL = 'https://fal.test/files/logo.png';
    const DELIVERABLE = '99999999-9999-4999-8999-999999999999';

    function setup(options: { fetchImpl?: typeof fetch; storage?: InMemoryObjectStorage; storeArtifacts?: never; metadata?: Record<string, unknown> } = {}) {
      const subscriber = new FakeSubscriber();
      const registry = new AgentRegistry();
      registry.register(logoCard as AgentCard, vi.fn(async (message: A2AMessage) => ({
        status: 'completed' as const,
        taskId: message.taskId,
        artifacts: [{ kind: 'image', url: PROVIDER_URL, metadata: options.metadata ?? { provider: 'fal' } }],
        completedAt: '2026-05-04T00:00:01Z',
      })), undefined);
      const row = buildAgentTaskRow({
        id: '33333333-3333-4333-8333-333333333333' as TaskId,
        conversationId: '44444444-4444-4444-8444-444444444444' as never,
      });
      const order: string[] = [];
      const storage = options.storage ?? new InMemoryObjectStorage();
      const put = storage.putObject.bind(storage);
      storage.putObject = async (...args) => {
        order.push('put');
        return put(...args);
      };
      const fetchImpl = options.fetchImpl
        ?? (vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch);
      const settleTaskAndEnqueue = vi.fn(async (input: { state: string }) => {
        order.push('settle');
        return { deliverableIds: input.state === 'completed' ? [DELIVERABLE] : [] };
      });
      const onTaskSettled = vi.fn(async () => undefined);
      const ctx = buildWorkerTestContext({
        subscriber,
        registry,
        systemReposFor: () => ({
          agentTasks: { findById: vi.fn(async () => ({ ...row, status: 'pending' as const })), claimById: vi.fn(async () => row) } as never,
          llmCalls: {} as never,
        }),
        settleTaskFor: () => ({ settleTaskAndEnqueue } as never),
        storeArtifacts: options.storeArtifacts ?? ((input) => storeArtifactImages(input, { storage, fetchImpl })),
        onTaskSettled,
      });
      const run = async () => {
        await startLogoAgentWorker(ctx);
        const onMessage = subscriber.listeners('message')[0] as (channel: string, payload: string) => Promise<void>;
        await onMessage(channelForAgent('logo-agent' as AgentId), wakeUp({ taskId: row.id, tenantId: TENANT, agentId: 'logo-agent' }));
      };
      return { row, storage, order, settleTaskAndEnqueue, onTaskSettled, run };
    }

    it('uploads the image before the durable settlement and announces only the asset route', async () => {
      const t = setup();
      await t.run();

      const key = `tenants/${TENANT}/conversations/${t.row.conversationId}/tasks/${t.row.id}/0.png`;
      expect(t.order).toEqual(['put', 'settle']);
      expect(t.storage.objects.get(key)?.contentType).toBe('image/png');
      expect(t.settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        state: 'completed',
        artifacts: [{ kind: 'image', url: PROVIDER_URL, metadata: { provider: 'fal' }, storageKey: key }],
      }));
      const [, state] = (t.onTaskSettled.mock.calls[0] as unknown) as [TaskId, TaskState];
      if (state.status !== 'completed') throw new Error('expected completed');
      expect(state.result.artifacts).toEqual([{ kind: 'image', url: `/api/assets/${DELIVERABLE}`, metadata: { provider: 'fal' } }]);
      expect(JSON.stringify(state)).not.toContain(PROVIDER_URL);
      expect(JSON.stringify(state)).not.toContain('tenants/');
    });

    it('stores a logo that did not pass the safety check, with its verdict, but announces it without any URL (KAN-33)', async () => {
      const metadata = { provider: 'fal', safety: { verdict: 'rejected', category: 'sexual_content' } };
      const t = setup({ metadata });
      await t.run();

      expect(t.storage.objects.size).toBe(1);
      expect(t.settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        state: 'completed',
        artifacts: [expect.objectContaining({ url: PROVIDER_URL, metadata })],
      }));
      const [, state] = (t.onTaskSettled.mock.calls[0] as unknown) as [TaskId, TaskState];
      if (state.status !== 'completed') throw new Error('expected completed');
      expect(state.result.artifacts).toEqual([{ kind: 'image', metadata }]);
    });

    it.each([
      ['the download fails', () => ({ fetchImpl: vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch })],
      ['the provider returns no image', () => ({ fetchImpl: vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch })],
      ['the upload fails', () => {
        const storage = new InMemoryObjectStorage();
        storage.failPuts = new Error('bucket unavailable');
        return { storage };
      }],
    ])('fails the task durably as transient storage_unavailable with no deliverable when %s', async (_label, options) => {
      const t = setup(options());
      await t.run();

      expect(t.settleTaskAndEnqueue).toHaveBeenCalledTimes(1);
      expect(t.settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        state: 'failed',
        artifacts: [],
        error: expect.objectContaining({ kind: 'storage_unavailable' }),
        errorCategory: 'transient',
      }));
      expect(t.storage.objects.size).toBe(0);
      expect(t.onTaskSettled).toHaveBeenCalledWith(t.row.id, expect.objectContaining({ status: 'failed' }), [],
        expect.objectContaining({ durableSettlement: true }));
    });

    it('fails with config_missing when the bucket is not configured in production', async () => {
      const t = setup({ storeArtifacts: (async () => { throw new StorageConfigError(['BUCKET_NAME']); }) as never });
      await t.run();
      expect(t.settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({
        state: 'failed',
        artifacts: [],
        error: expect.objectContaining({ kind: 'config_missing' }),
        errorCategory: 'permanent_bug',
      }));
    });
  });
});
