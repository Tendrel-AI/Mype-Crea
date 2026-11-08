/**
 * Shared worker dependency shape.
 *
 * Every per-agent worker (logo, tagline, label, social) drains a Redis
 * dispatch channel, re-reads the canonical agent_tasks row, runs its
 * registered handler, and reports back via onTaskSettled. The deps are
 * identical; only the channel name and the handler change.
 *
 * Centralizing the shape here keeps individual workers small and means
 * future workers inherit lifecycle/lookup/persistence wiring for free.
 */
import type { Redis as RedisClient } from 'ioredis';
import type {
  AgentId,
  ConversationId,
  DeliverableId,
  TaskId,
  UUID,
} from '../core/contracts';
import type { A2AMessage, TaskState } from '../core/agent-types';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import type { IAgentLifecycleNotifier } from '../core/orchestrator/agent-lifecycle-notifier';
import type { TaskSettlementContext } from '../core/orchestrator/runtime-config';
import type { DeliverableInsert, DeliverableRow } from '../repos/models';
import type { SystemRepos, Tenant } from '../repos';
import type { AiTurnsRepo } from '../repos/ai-turns';
import type { StoreArtifactImages } from '../services/storage/artifact-store';

export interface DeliverablesRepoLike {
  insert(input: DeliverableInsert): Promise<Pick<DeliverableRow, 'id'>>;
}

/**
 * Dependencies every agent worker needs. Per-agent workers may extend this
 * with handler-specific extras; the orchestrator runtime wires the same
 * object into all of them.
 */
export interface WorkerContext {
  readonly subscriber: RedisClient;
  readonly registry: AgentRegistry;
  readonly systemReposFor: (tenant: Tenant) => SystemRepos;
  /**
   * Resolve the conversation's owner user_id. Workers have no User in scope
   * (they're system components), so they can't use the regular `repos(tenant,
   * user)` factory until they've looked this up. Returns null if the
   * conversation has been deleted under us.
   */
  readonly resolveConversationOwner: (
    tenantId: UUID,
    conversationId: ConversationId,
  ) => Promise<UUID | null>;
  /**
   * Build a user-scoped deliverables repo. Called after resolveConversationOwner
   * so the worker can persist artifacts under the correct (tenant, user) RLS
   * context. Optional: when omitted (unit tests), persistence is skipped and
   * the worker still calls onTaskSettled with an empty deliverableIds.
   */
  readonly deliverablesFor?: (
    tenantId: UUID,
    userId: UUID,
  ) => DeliverablesRepoLike;
  /**
   * The frozen prompt of the conversation's pinned version for an agent (D22). Optional: when
   * omitted or failing, the handler uses the active frozen version.
   */
  readonly pinnedPromptFor?: (tenantId: UUID, conversationId: ConversationId, agentId: AgentId) => Promise<A2AMessage['prompt']>;
  /**
   * Copy generated images into private object storage before settlement
   * (KAN-52). Defaults to `storeArtifactImages` over the configured bucket
   * service; tests inject a fake. Throws a typed task error on failure.
   */
  readonly storeArtifacts?: StoreArtifactImages;
  /** Atomic terminal task, deliverables, core-state and outbox commit. */
  readonly settleTaskFor?: (tenantId: UUID, userId: UUID) => Pick<AiTurnsRepo, 'settleTaskAndEnqueue'>;
  /**
   * Wired to OrchestratorCoreImpl.onTaskSettled at runtime boot. The
   * `deliverableIds` parameter carries the ids of the deliverables rows the
   * worker has just persisted.
   */
  readonly onTaskSettled: (
    taskId: TaskId,
    state: TaskState,
    deliverableIds: ReadonlyArray<DeliverableId>,
    context?: TaskSettlementContext,
  ) => Promise<void> | void;
  /**
   * Used to publish "task processing" lifecycle events as soon as the worker
   * has claimed a row. The SSE route subscribes here so the UI can render a
   * spinner while the handler is running.
   */
  readonly lifecycleNotifier?: IAgentLifecycleNotifier;
}
