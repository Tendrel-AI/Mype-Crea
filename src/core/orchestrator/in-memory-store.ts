import type {
  AgentId,
  AgentRequirementState,
  ConversationId,
  ConversationSnapshot,
  FieldName,
  FieldSlot,
  TaskId,
  UUID,
} from '../contracts';

export interface AgentFieldSchema {
  readonly agentId: AgentId;
  readonly displayOrder: number;
  readonly requiredFields: ReadonlyArray<FieldName>;
  readonly optionalFields: ReadonlyArray<FieldName>;
}

export interface IConversationStore {
  getOrCreate(
    conversationId: ConversationId,
    tenantId: UUID,
    userId: UUID,
  ): Promise<ConversationSnapshot>;
  get(conversationId: ConversationId): Promise<ConversationSnapshot | undefined>;
  updateFieldSlot(
    conversationId: ConversationId,
    agentId: AgentId,
    fieldName: FieldName,
    isRequired: boolean,
    slot: FieldSlot,
  ): Promise<void>;
  recordDispatch(
    conversationId: ConversationId,
    agentId: AgentId,
    taskId: TaskId,
  ): Promise<void>;
  clearDispatch(conversationId: ConversationId, agentId: AgentId): Promise<void>;
}

/**
 * In-memory ConversationStore. Phase 1 only — Phase B replaces this with a
 * Postgres-backed implementation that uses the repository pattern from
 * `claude/skills/database/SKILL.md` (withTransaction + set_config GUCs).
 */
export class InMemoryConversationStore implements IConversationStore {
  private readonly snapshots = new Map<ConversationId, ConversationSnapshot>();

  constructor(private readonly schemas: ReadonlyArray<AgentFieldSchema>) {}

  async getOrCreate(
    conversationId: ConversationId,
    tenantId: UUID,
    _userId: UUID,
  ): Promise<ConversationSnapshot> {
    const existing = this.snapshots.get(conversationId);
    if (existing) return existing;

    const agentStates: Record<AgentId, AgentRequirementState> = {};
    for (const schema of this.schemas) {
      const requiredFields: Record<FieldName, FieldSlot> = {};
      for (const fieldName of schema.requiredFields) {
        requiredFields[fieldName] = { status: 'empty' };
      }
      const optionalFields: Record<FieldName, FieldSlot> = {};
      for (const fieldName of schema.optionalFields) {
        optionalFields[fieldName] = { status: 'empty' };
      }
      agentStates[schema.agentId] = {
        requiredFields,
        optionalFields,
        iterationCount: 0,
      };
    }

    const snapshot: ConversationSnapshot = {
      conversationId,
      tenantId,
      agentStates,
      updatedAt: new Date().toISOString(),
    };
    this.snapshots.set(conversationId, snapshot);
    return snapshot;
  }

  async get(conversationId: ConversationId): Promise<ConversationSnapshot | undefined> {
    return this.snapshots.get(conversationId);
  }

  async updateFieldSlot(
    conversationId: ConversationId,
    agentId: AgentId,
    fieldName: FieldName,
    isRequired: boolean,
    slot: FieldSlot,
  ): Promise<void> {
    const snapshot = this.snapshots.get(conversationId);
    if (!snapshot) throw new Error(`Unknown conversation: ${conversationId}`);
    const agentState = snapshot.agentStates[agentId];
    if (!agentState) throw new Error(`Unknown agent in snapshot: ${agentId}`);

    const sliceKey = isRequired ? 'requiredFields' : 'optionalFields';
    const updatedAgent: AgentRequirementState = {
      ...agentState,
      [sliceKey]: {
        ...agentState[sliceKey],
        [fieldName]: slot,
      },
    };
    this.snapshots.set(conversationId, {
      ...snapshot,
      agentStates: { ...snapshot.agentStates, [agentId]: updatedAgent },
      updatedAt: new Date().toISOString(),
    });
  }

  async recordDispatch(
    conversationId: ConversationId,
    agentId: AgentId,
    taskId: TaskId,
  ): Promise<void> {
    const snapshot = this.snapshots.get(conversationId);
    if (!snapshot) throw new Error(`Unknown conversation: ${conversationId}`);
    const agentState = snapshot.agentStates[agentId];
    if (!agentState) throw new Error(`Unknown agent in snapshot: ${agentId}`);

    const updatedAgent: AgentRequirementState = {
      ...agentState,
      lastDispatchedTaskId: taskId,
      iterationCount: agentState.iterationCount + 1,
    };
    this.snapshots.set(conversationId, {
      ...snapshot,
      agentStates: { ...snapshot.agentStates, [agentId]: updatedAgent },
      updatedAt: new Date().toISOString(),
    });
  }

  async clearDispatch(conversationId: ConversationId, agentId: AgentId): Promise<void> {
    const snapshot = this.snapshots.get(conversationId);
    if (!snapshot) throw new Error(`Unknown conversation: ${conversationId}`);
    const agentState = snapshot.agentStates[agentId];
    if (!agentState) throw new Error(`Unknown agent in snapshot: ${agentId}`);

    const { lastDispatchedTaskId: _drop, ...rest } = agentState;
    this.snapshots.set(conversationId, {
      ...snapshot,
      agentStates: { ...snapshot.agentStates, [agentId]: rest as AgentRequirementState },
      updatedAt: new Date().toISOString(),
    });
  }
}
