/**
 * A2AMessage factory for worker tests and any other code that needs to feed
 * an `A2AMessage` into an agent handler without going through the orchestrator.
 */
import type { A2AMessage } from '../../agent-types';
import type { AgentId, TaskId } from '../../contracts';
import { TEST_TENANT_ID } from './snapshot';

export const TEST_TASK_ID = '33333333-3333-3333-3333-333333333333' as TaskId;

export function buildA2AMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    taskId: TEST_TASK_ID,
    tenantId: TEST_TENANT_ID,
    agentId: 'logo-agent' as AgentId,
    agentCardVersion: '0.1.0',
    requirements: {},
    createdAt: '2026-05-04T00:00:00Z',
    ...overrides,
  };
}
