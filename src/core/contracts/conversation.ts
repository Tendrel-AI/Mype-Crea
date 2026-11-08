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
  AdapterSource,
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
  /**
   * What the conversation belongs to (KAN-89). Absent on legacy conversations and in-memory stores,
   * which behave as «no brand, no product». A product conversation only reads brand-level deliverables.
   */
  readonly links?: { readonly hasBrand: boolean; readonly hasProduct: boolean };
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

/**
 * `source` is the `FieldDelta.source` that wrote the value (KAN-26 provenance:
 * chat or brief panel). Audit and display only: merge and planner never
 * branch on it. Absent on slots written before KAN-26.
 */
export type FieldSlot =
  | { readonly status: 'empty' }
  | { readonly status: 'pending_confirmation'; readonly value: unknown; readonly confidence: number; readonly source?: AdapterSource }
  | { readonly status: 'filled'; readonly value: unknown; readonly confidence: number; readonly source?: AdapterSource };
