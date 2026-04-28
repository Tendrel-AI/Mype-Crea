/**
 * Postgres-backed IConversationStore. Delegates every operation to the
 * conversations repository (src/repos/conversations.ts), which runs each
 * call inside a tenant-scoped transaction with the right GUCs.
 *
 * The IConversationStore interface signatures don't carry tenant/user past
 * getOrCreate, so we cache (conversationId -> {tenant, user}) at start and
 * reuse it for subsequent reads/writes. A real session is bound to a single
 * (tenant, user); we don't need to handle hand-offs.
 */
import type {
  AgentId,
  ConversationId,
  ConversationSnapshot,
  FieldName,
  FieldSlot,
  TaskId,
  UUID,
} from '../contracts';
import { repos, type Tenant, type User } from '../../repos';
import type { AgentFieldSchema, IConversationStore } from './in-memory-store';

interface ConversationActor {
  readonly tenant: Tenant;
  readonly user: User;
}

export class PostgresConversationStore implements IConversationStore {
  private readonly actorByConversation = new Map<ConversationId, ConversationActor>();

  constructor(private readonly schemas: ReadonlyArray<AgentFieldSchema>) {}

  async getOrCreate(
    conversationId: ConversationId,
    tenantId: UUID,
    userId: UUID,
  ): Promise<ConversationSnapshot> {
    const actor: ConversationActor = { tenant: { id: tenantId }, user: { id: userId } };
    this.actorByConversation.set(conversationId, actor);
    return repos(actor.tenant, actor.user).conversations.getOrCreate(
      conversationId,
      this.schemas,
    );
  }

  async get(conversationId: ConversationId): Promise<ConversationSnapshot | undefined> {
    const actor = this.actorByConversation.get(conversationId);
    if (!actor) return undefined;
    return repos(actor.tenant, actor.user).conversations.get(conversationId, this.schemas);
  }

  async updateFieldSlot(
    conversationId: ConversationId,
    agentId: AgentId,
    fieldName: FieldName,
    isRequired: boolean,
    slot: FieldSlot,
  ): Promise<void> {
    const actor = this.requireActor(conversationId);
    await repos(actor.tenant, actor.user).conversations.updateFieldSlot(
      conversationId,
      agentId,
      fieldName,
      isRequired,
      slot,
      this.schemas,
    );
  }

  async recordDispatch(
    conversationId: ConversationId,
    agentId: AgentId,
    taskId: TaskId,
  ): Promise<void> {
    const actor = this.requireActor(conversationId);
    await repos(actor.tenant, actor.user).conversations.recordDispatch(
      conversationId,
      agentId,
      taskId,
      this.schemas,
    );
  }

  async clearDispatch(conversationId: ConversationId, agentId: AgentId): Promise<void> {
    const actor = this.requireActor(conversationId);
    await repos(actor.tenant, actor.user).conversations.clearDispatch(
      conversationId,
      agentId,
      this.schemas,
    );
  }

  private requireActor(conversationId: ConversationId): ConversationActor {
    const actor = this.actorByConversation.get(conversationId);
    if (!actor) {
      throw new Error(
        `PostgresConversationStore has no actor for ${conversationId}. Call startConversation() first.`,
      );
    }
    return actor;
  }
}
