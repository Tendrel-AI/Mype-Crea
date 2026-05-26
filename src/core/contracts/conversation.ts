/**
 * MYPES Platform — Conversation state contracts
 * ==============================================
 *
 * Read-only views into a conversation's per-agent requirement state. Used by
 * tests, tooling, and the admin dashboard; adapters render decisions instead
 * of inspecting state directly.
 *
 * See `../contracts.ts` for the barrel re-export and the file-level rules.
 */

import type {
  AgentId,
  ConversationId,
  DeliverableId,
  FieldName,
  ISOTimestamp,
  TaskId,
  UUID,
} from './ids';

export interface ConversationSnapshot {
  readonly conversationId: ConversationId;
  readonly tenantId: UUID;
  readonly agentStates: {
    readonly [agentId: AgentId]: AgentRequirementState;
  };
  readonly updatedAt: ISOTimestamp;
}

export interface AgentRequirementState {
  readonly requiredFields: {
    readonly [fieldName: FieldName]: FieldSlot;
  };
  readonly optionalFields: {
    readonly [fieldName: FieldName]: FieldSlot;
  };
  readonly lastDispatchedTaskId?: TaskId;
  readonly iterationCount: number;
  readonly selectedDeliverableId?: DeliverableId;
}

export type FieldSlot =
  | { readonly status: 'empty' }
  | { readonly status: 'pending_confirmation'; readonly value: unknown; readonly confidence: number }
  | { readonly status: 'filled'; readonly value: unknown; readonly confidence: number };
