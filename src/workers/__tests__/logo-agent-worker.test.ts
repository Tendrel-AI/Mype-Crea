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
import { startLogoAgentWorker } from '../logo-agent-worker';
import { channelForAgent } from '../../transport/redis-queue-adapter';
import {
  AgentRegistry,
  type AgentCard,
} from '../../core/orchestrator/agent-registry';
import logoCard from '../../../agents/logo-agent/agent-card.json';
import type {
  A2AMessage,
  AgentHandler,
  TaskState,
} from '../../core/agent-types';
import type { AgentId, TaskId } from '../../core/contracts';
import {
  buildAgentTaskRow,
  buildWorkerTestContext,
  FakeSubscriber,
  flushMicrotasks,
} from './_helpers';

describe('logo-agent worker', () => {
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
      JSON.stringify({
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
    subscriber.emitMessage(channelForAgent('logo-agent' as AgentId), JSON.stringify({
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
      JSON.stringify({
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
      JSON.stringify({
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
      JSON.stringify({
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
      JSON.stringify({
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
});
