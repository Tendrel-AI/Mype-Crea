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

    expect(claimById).toHaveBeenCalledWith(row.id);
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
