/**
 * ConversationSnapshot factory for tests.
 *
 * Defaults are intentionally minimal — no agent states. Pass overrides for the
 * fields a given test cares about. Reuse stable test UUIDs so assertions can
 * pin against literals.
 */
import type {
  AgentRequirementState,
  ConversationId,
  ConversationSnapshot,
  UUID,
} from '../../contracts';

export const TEST_CONVERSATION_ID = '00000000-0000-0000-0000-000000000003' as ConversationId;
export const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001' as UUID;
export const TEST_USER_ID = '00000000-0000-0000-0000-000000000002' as UUID;

export function buildSnapshot(
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    conversationId: TEST_CONVERSATION_ID,
    tenantId: TEST_TENANT_ID,
    agentStates: {},
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Convenience: an empty AgentRequirementState seed. */
export function buildAgentRequirementState(
  overrides: Partial<AgentRequirementState> = {},
): AgentRequirementState {
  return {
    requiredFields: {},
    optionalFields: {},
    iterationCount: 0,
    ...overrides,
  };
}
