/**
 * KAN-82: without Redis, the production transport still settles a task
 * through the worker's durable path (`settleTaskAndEnqueue`: deliverables
 * plus the outbox notice), exactly as with Redis. Repos and Redis are faked;
 * no database, no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTransport, resetOrchestratorRuntime } from '../runtime';
import { AgentRegistry, type AgentCard } from '../agent-registry';
import logoCard from '../../../../agents/logo-agent/agent-card.json';
import nameCard from '../../../../agents/name-agent/agent-card.json';
import type { A2ATaskResult, TaskState } from '../../agent-types';
import type { TaskId } from '../../contracts';
import { buildA2AMessage, TEST_TENANT_ID } from '../../__tests__/_fixtures';
import { buildAgentTaskRow } from '../../../workers/__tests__/_helpers';

const OWNER = '22222222-2222-4222-8222-222222222222';
const DELIVERABLE = '99999999-9999-4999-8999-999999999999';
type WithoutTaskId<T> = T extends unknown ? Omit<T, 'taskId'> : never;

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  claimById: vi.fn(),
  settleTaskAndEnqueue: vi.fn(),
  repos: vi.fn(),
}));

vi.mock('../../../services/account-status', () => ({ isUserActive: async () => true }));
vi.mock('../../../services/redis', () => ({ getRedisPublisher: () => null, getRedisSubscriber: () => null }));
vi.mock('../../../repos/global', () => ({ globalRepos: () => ({ organizations: { list: async () => [] } }) }));
vi.mock('../../../repos/conversations', () => ({ getConversationOwnerUserId: async () => OWNER }));
vi.mock('../../../repos', () => ({
  repos: mocks.repos,
  systemRepos: () => ({ agentTasks: { findById: mocks.findById, claimById: mocks.claimById } }),
}));

afterEach(() => {
  resetOrchestratorRuntime();
  vi.clearAllMocks();
});

async function settleWithoutRedis(card: AgentCard, result: WithoutTaskId<A2ATaskResult>) {
  const row = buildAgentTaskRow({ agentId: card.name });
  mocks.findById.mockResolvedValue({ ...row, status: 'pending' });
  mocks.claimById.mockResolvedValue(row);
  mocks.settleTaskAndEnqueue.mockResolvedValue({ deliverableIds: result.status === 'completed' ? [DELIVERABLE] : [] });
  mocks.repos.mockReturnValue({ aiTurns: { settleTaskAndEnqueue: mocks.settleTaskAndEnqueue } });

  const registry = new AgentRegistry();
  const handler = vi.fn(async () => ({ ...result, taskId: row.id }) as A2ATaskResult);
  registry.register(card, handler, undefined);

  let onSettled!: (args: unknown[]) => void;
  const settled = new Promise<unknown[]>((resolve) => (onSettled = resolve));
  const transport = buildTransport(registry as never, async (...args) => onSettled(args));
  await transport.dispatch(buildA2AMessage({ taskId: row.id as TaskId, agentId: card.name }));
  const [taskId, state, deliverableIds, context] = await settled;
  return { row, handler, taskId, state: state as TaskState, deliverableIds, context };
}

describe('buildTransport without Redis (KAN-82)', () => {
  it.each([
    ['logo-agent', logoCard, 'logo'],
    ['name-agent', nameCard, 'business_name'],
  ])('a completed %s task persists its deliverable and outbox notice durably', async (_id, card, kind) => {
    const artifact = { kind: 'text', inline: 'Sazón Andino' };
    const out = await settleWithoutRedis(card as AgentCard, {
      status: 'completed',
      artifacts: [artifact],
      completedAt: '2026-05-04T00:00:01Z',
    });

    expect(mocks.claimById).toHaveBeenCalledWith(out.row.id, card.name);
    expect(out.handler).toHaveBeenCalledTimes(1);
    expect(mocks.repos).toHaveBeenCalledWith({ id: TEST_TENANT_ID }, { id: OWNER });
    expect(mocks.settleTaskAndEnqueue).toHaveBeenCalledWith({
      conversationId: out.row.conversationId,
      taskId: out.row.id,
      state: 'completed',
      deliverableKind: kind,
      artifacts: [artifact],
    });
    expect(out.taskId).toBe(out.row.id);
    expect(out.state.status).toBe('completed');
    expect(out.deliverableIds).toEqual([DELIVERABLE]);
    expect(out.context).toMatchObject({ tenantId: TEST_TENANT_ID, ownerUserId: OWNER, durableSettlement: true });
  });

  it('a failed task writes the durable failure notice with its classified category', async () => {
    const out = await settleWithoutRedis(logoCard as AgentCard, {
      status: 'failed',
      error: { kind: 'rate_limited', message: 'slow down' },
      completedAt: '2026-05-04T00:00:01Z',
    });

    expect(mocks.settleTaskAndEnqueue).toHaveBeenCalledWith({
      conversationId: out.row.conversationId,
      taskId: out.row.id,
      state: 'failed',
      deliverableKind: 'logo',
      artifacts: [],
      error: { kind: 'rate_limited', message: 'slow down' },
      errorCategory: 'transient',
    });
    expect(out.state.status).toBe('failed');
    expect(out.context).toMatchObject({ durableSettlement: true });
  });
});
