/**
 * social-agent worker: a dispatch on the social-agent channel claims the task, runs the registered handler with the
 * snapshot (including the product facts and photos) and settles the result as a `social_pack` deliverable.
 */
import { describe, expect, it, vi } from 'vitest';
import { SOCIAL_WORKER, startAgentWorker } from '../agent-worker';
import { channelForAgent, dispatchWakeUp } from '../../transport/redis-queue-adapter';
import { AgentRegistry, type AgentCard } from '../../core/orchestrator/agent-registry';
import socialCard from '../../../agents/social-agent/agent-card.json';
import type { A2AMessage } from '../../core/agent-types';
import type { AgentId } from '../../core/contracts';
import { buildAgentTaskRow, buildWorkerTestContext, FakeSubscriber, flushMicrotasks } from './_helpers';

describe('social-agent worker', () => {
  it('runs the handler on the social-agent channel and settles a social_pack deliverable', async () => {
    const subscriber = new FakeSubscriber();
    const registry = new AgentRegistry();
    const artifacts = [{ kind: 'image', url: 'https://example.test/ad.png' }];
    const handler = vi.fn(async (message: A2AMessage) => ({
      status: 'completed' as const,
      taskId: message.taskId,
      artifacts,
      completedAt: '2026-05-04T00:00:01Z',
    }));
    registry.register(socialCard as AgentCard, handler, undefined);
    const photos = [{ fileId: 'f', storageKey: 'k', contentType: 'image/png', originalName: 'a.png' }];
    const row = buildAgentTaskRow({
      agentId: 'social-agent',
      requirementsSnapshot: { ad_brief: 'sorpréndeme', product_facts: { package_type: 'botella' }, product_photos: photos },
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
    }), SOCIAL_WORKER);
    expect(subscriber.subscribed).toEqual([channelForAgent('social-agent' as AgentId)]);
    subscriber.emitMessage(channelForAgent('social-agent' as AgentId), dispatchWakeUp({
      taskId: row.id,
      tenantId: '66666666-6666-6666-6666-666666666666',
      agentId: 'social-agent',
    }).message);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(claimById).toHaveBeenCalledWith(row.id, 'social-agent');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ requirements: row.requirementsSnapshot }), undefined);
    expect(settleTaskAndEnqueue).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed', deliverableKind: 'social_pack', artifacts }));
  });
});
