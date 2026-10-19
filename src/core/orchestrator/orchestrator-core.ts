/**
 * MYPES Platform — Orchestrator core
 * ===================================
 *
 * Location: src/core/orchestrator/orchestrator-core.ts
 *
 * The reference implementation of OrchestratorCore. Wires together:
 *   - the conversation store
 *   - the merge stage
 *   - the planner
 *   - the agent transport (IAgentTransport)
 *   - the decision notifier (how output adapters wake up)
 *
 * This file is WHERE the pipeline lives. It does not contain business logic;
 * all logic lives in merge.ts and planner.ts. If you find yourself adding an
 * `if` about a specific field or agent here, stop — it belongs somewhere else.
 *
 * See also:
 *   - contracts.ts                (OrchestratorCore interface)
 *   - merge.ts / planner.ts       (the two stages wired below)
 *   - local-adapter.ts            (the IAgentTransport implementation)
 *   - docs/agents/architecture.md  (rules 1, 2: modality-blind core)
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AgentId,
  AnnounceDispatchDecision,
  ConversationId,
  ConversationSnapshot,
  DeliverableId,
  FieldDelta,
  FieldSlot,
  OrchestratorCore,
  PlannerDecision,
  TaskId,
  UUID,
} from '../contracts';
import type { A2AMessage, IAgentTransport, TaskState } from '../agent-types';
import { loggerFor } from '../../services/logger';
import type { AgentRegistry } from './agent-registry';
import type { TaskSettlementContext } from './runtime-config';
import type { IConversationStore } from './in-memory-store';
import { mergeFieldDelta } from './merge';
import { findAgentReadyToDispatch, planNextDecision } from './planner';
import type { IArtifactNotifier } from './artifact-notifier';

/**
 * Subset of AgentTasksRepo the orchestrator consumes. The orchestrator
 * doesn't need the full repo surface — narrowing the dep surface keeps
 * tests easy to fake.
 */
export interface AgentTasksRepoLike {
  insertRoot(input: {
    conversationId: ConversationId;
    agentId: string;
    agentCardVersion: string;
    idempotencyKey: UUID;
    requirementsSnapshot: Record<string, unknown>;
  }): Promise<{ id: TaskId }>;
  markCompleted(id: TaskId): Promise<void>;
  markFailed(
    id: TaskId,
    error: Record<string, unknown>,
    errorCategory: 'transient' | 'content_policy' | 'permanent_bug',
  ): Promise<void>;
}


const log = loggerFor('orchestrator.core');

// ---------------------------------------------------------------------------
// Decision notifier — in prod this is Postgres LISTEN/NOTIFY
// ---------------------------------------------------------------------------

export interface IDecisionNotifier {
  notify(conversationId: ConversationId, decision: PlannerDecision): void;
  subscribe(
    conversationId: ConversationId,
    handler: (decision: PlannerDecision) => void,
  ): { dispose(): void };
}

/** In-process notifier. Production replaces with a LISTEN/NOTIFY-backed one. */
export class InProcessDecisionNotifier implements IDecisionNotifier {
  private readonly emitter = new EventEmitter();

  notify(conversationId: ConversationId, decision: PlannerDecision): void {
    this.emitter.emit(conversationId, decision);
  }

  subscribe(
    conversationId: ConversationId,
    handler: (decision: PlannerDecision) => void,
  ): { dispose(): void } {
    this.emitter.on(conversationId, handler);
    return {
      dispose: () => this.emitter.off(conversationId, handler),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator core
// ---------------------------------------------------------------------------

export interface OrchestratorCoreDeps {
  readonly store: IConversationStore;
  readonly registry: AgentRegistry;
  readonly transport: IAgentTransport;
  readonly notifier: IDecisionNotifier;
  /** Factory used for task IDs and conversation creation defaults. Deterministic in tests. */
  readonly newTaskId: () => TaskId;
  /**
   * Optional factory for the agent_tasks repository, scoped to a tenant. When
   * provided, dispatchAgent inserts a row and onTaskSettled marks
   * completed/failed. When omitted (in-memory unit tests), the orchestrator
   * keeps working off the in-memory taskOwnership map only.
   */
  readonly agentTasksFor?: (tenantId: UUID) => AgentTasksRepoLike;
  /**
   * Optional artifact notifier. When provided, onTaskSettled publishes the
   * artifacts produced by a completed task on this channel. The SSE/UI edge
   * subscribes here. Decision flow is unaffected when omitted.
   */
  readonly artifactNotifier?: IArtifactNotifier;
}

export class OrchestratorCoreImpl implements OrchestratorCore {
  /** Conversations the core knows about — tenantId is recorded here so we don't re-ask every call. */
  private readonly conversationTenants = new Map<ConversationId, UUID>();

  /**
   * Map from taskId to the (conversationId, agentId) pair that dispatched it.
   * Populated in dispatchAgent, consumed in onTaskSettled. Replaces what a
   * real Postgres implementation would do with a `tasks` table lookup.
   */
  private readonly taskOwnership = new Map<
    TaskId,
    { readonly conversationId: ConversationId; readonly agentId: AgentId }
  >();

  /**
   * Tasks whose completion we've observed but whose announce_completion
   * decision we have not yet delivered. Cleared when getNextDecision or
   * applyDelta surfaces the decision.
   */
  private readonly pendingCompletions = new Map<ConversationId, PendingCompletion[]>();

  /**
   * Dispatches that have happened but whose announce_dispatch decision has
   * not yet been surfaced through getNextDecision. The Responder reads these
   * once and the entry is removed; subsequent turns no longer re-announce.
   */
  private readonly pendingDispatches = new Map<ConversationId, AnnounceDispatchDecision[]>();

  constructor(private readonly deps: OrchestratorCoreDeps) {
    // Wire completion notifications from the transport back into the core.
    // For the LocalAdapter case, this is set via its constructor callback;
    // for distributed transports, a webhook handler calls this method.
    // (This file assumes deps.transport was created with onTaskSettled bound
    // to this.onTaskSettled — see how the test wires it up.)
  }

  /**
   * Register that we're starting a conversation for tenant X. Must be called
   * before the first applyDelta. In production, this happens in the HTTP
   * session handler when a new chat starts.
   */
  async startConversation(
    conversationId: ConversationId,
    tenantId: UUID,
    userId: UUID,
  ): Promise<void> {
    await this.deps.store.getOrCreate(conversationId, tenantId, userId);
    // Cache only after the scoped store call has authorized the actor.
    this.conversationTenants.set(conversationId, tenantId);
  }

  async applyDelta(delta: FieldDelta): Promise<ConversationSnapshot> {
    const tenantId = this.conversationTenants.get(delta.conversationId);
    if (!tenantId) {
      throw new Error(
        `Conversation not started: ${delta.conversationId}. Call startConversation() first.`,
      );
    }

    const child = log.child({
      op: 'applyDelta',
      tenantId,
      conversationId: delta.conversationId,
      source: delta.source,
    });

    // Stamp the cycle entry with the contract that crosses this boundary.
    // `orchestrator.input` is the symmetric counterpart of the upstream
    // `extractor.output`: the same FieldDelta, observed from inside the core.
    const incomingFields = Object.fromEntries(
      Object.entries(delta.fields).map(([agentId, fields]) => [
        agentId,
        Object.fromEntries(
          Object.entries(fields).map(([name, v]) => [
            name,
            { confidence: v.confidence, valuePreview: previewValue(v.value) },
          ]),
        ),
      ]),
    );
    child.info(
      {
        contract: 'FieldDelta',
        timestamp: delta.timestamp,
        fieldCount: Object.values(delta.fields).reduce((acc, f) => acc + Object.keys(f).length, 0),
        intentCount: delta.intents?.length ?? 0,
        fields: incomingFields,
        intents: (delta.intents ?? []).map((i) => ({
          kind: i.kind,
          agentId: 'agentId' in i ? i.agentId : undefined,
        })),
      },
      'orchestrator.input',
    );

    // 1) Merge the delta into state.
    await mergeFieldDelta(delta, this.deps.store, this.deps.registry);

    // 2) Check whether any agent is now ready to dispatch.
    const snapshotAfterMerge = (await this.deps.store.get(delta.conversationId))!;
    const readyAgentId = findAgentReadyToDispatch(
      snapshotAfterMerge,
      this.deps.registry.getFieldSchemas(),
    );

    if (readyAgentId) {
      child.info({ agentId: readyAgentId }, 'orchestrator.dispatch.triggered');
      await this.dispatchAgent(delta.conversationId, readyAgentId);
      // dispatch will emit announce_dispatch via the notifier.
    }

    // 3) Emit the current planner plan so subscribers catch up. We notify
    // per decision so existing IDecisionNotifier subscribers (single-decision
    // shape) stay compatible after the multi-decision change.
    const plan = await this.peekNextDecision(delta.conversationId);
    for (const decision of plan) {
      this.deps.notifier.notify(delta.conversationId, decision);
    }

    child.info(
      {
        contract: 'PlannerDecision[]',
        plan: plan.map((decision) => ({
          kind: decision.kind,
          agentId: 'agentId' in decision ? decision.agentId : undefined,
          fieldName: 'fieldName' in decision ? decision.fieldName : undefined,
        })),
        dispatched: Boolean(readyAgentId),
        dispatchedAgent: readyAgentId ?? null,
      },
      'orchestrator.output',
    );
    return snapshotAfterMerge;
  }

  async getNextDecision(conversationId: ConversationId): Promise<ReadonlyArray<PlannerDecision>> {
    const plan = await this.peekNextDecision(conversationId);
    await this.acknowledgeDecisions(conversationId, plan);
    return plan;
  }

  /** Read the current plan without consuming queued announcements. */
  async peekNextDecision(conversationId: ConversationId): Promise<ReadonlyArray<PlannerDecision>> {
    const tenantId = this.conversationTenants.get(conversationId);
    const child = log.child({ op: 'getNextDecision', tenantId, conversationId });

    const plan: PlannerDecision[] = [];

    // 1. Include dispatch announcements that remain unacknowledged.
    const dispatches = this.pendingDispatches.get(conversationId);
    if (dispatches && dispatches.length > 0) {
      for (const announcement of dispatches) {
        plan.push(announcement);
        child.info(
          { agentId: announcement.agentId, taskId: announcement.taskId },
          'orchestrator.decision.announce_dispatch',
        );
      }
    }

    // 2. Include completion announcements (failed tasks fall through silently
    // for now; a future `announce_failure` variant can take their place).
    const pending = this.pendingCompletions.get(conversationId);
    if (pending && pending.length > 0) {
      for (const next of pending) {
        if (next.state.status === 'completed') {
          child.info(
            {
              agentId: next.agentId,
              taskId: next.taskId,
              artifactCount: next.state.result.artifacts.length,
            },
            'orchestrator.decision.announce_completion',
          );
          plan.push({
            kind: 'announce_completion',
            agentId: next.agentId,
            taskId: next.taskId,
            deliverableIds: next.deliverableIds,
            artifacts: next.state.result.artifacts,
          });
        } else {
          child.warn(
            { agentId: next.agentId, taskId: next.taskId },
            'orchestrator.decision.task_failed_falling_through',
          );
        }
      }
    }

    // 3. Ask the pure planner what the user-facing next step is. The planner
    // never produces announce_dispatch or announce_completion itself — those
    // are spliced in above by the orchestrator queues.
    const snapshot = await this.deps.store.get(conversationId);
    if (!snapshot) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    plan.push(...planNextDecision(snapshot, this.deps.registry));

    return plan;
  }

  /**
   * A controller calls this only after it has durably checkpointed the plan
   * for a turn. Task IDs make acknowledgement safe when another completion
   * is appended after the plan was read.
   */
  async acknowledgeDecisions(
    conversationId: ConversationId,
    decisions: ReadonlyArray<PlannerDecision>,
  ): Promise<void> {
    const acknowledged = new Set(
      decisions.flatMap((decision) =>
        decision.kind === 'announce_dispatch' || decision.kind === 'announce_completion'
          ? [`${decision.kind}:${decision.taskId}`]
          : [],
      ),
    );
    if (acknowledged.size === 0) return;

    const dispatches = this.pendingDispatches.get(conversationId);
    if (dispatches) {
      const remaining = dispatches.filter(
        (decision) => !acknowledged.has(`announce_dispatch:${decision.taskId}`),
      );
      if (remaining.length) this.pendingDispatches.set(conversationId, remaining);
      else this.pendingDispatches.delete(conversationId);
    }
    const completions = this.pendingCompletions.get(conversationId);
    if (completions) {
      const remaining = completions.filter(
        (completion) => !acknowledged.has(`announce_completion:${completion.taskId}`),
      );
      if (remaining.length) this.pendingCompletions.set(conversationId, remaining);
      else this.pendingCompletions.delete(conversationId);
    }
  }

  async getSnapshot(conversationId: ConversationId): Promise<ConversationSnapshot> {
    const snapshot = await this.deps.store.get(conversationId);
    if (!snapshot) throw new Error(`Unknown conversation: ${conversationId}`);
    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Dispatch and completion handling
  // -------------------------------------------------------------------------

  private async dispatchAgent(
    conversationId: ConversationId,
    agentId: string,
  ): Promise<void> {
    const snapshot = (await this.deps.store.get(conversationId))!;
    const agentState = snapshot.agentStates[agentId]!;
    const tenantId = this.conversationTenants.get(conversationId)!;
    const entry = this.deps.registry.get(agentId);
    const child = log.child({ op: 'dispatchAgent', tenantId, conversationId, agentId });

    // Build the requirements payload from filled slots.
    const requirements: Record<string, unknown> = {};
    for (const [fieldName, slot] of Object.entries(agentState.requiredFields) as Array<
      [string, FieldSlot]
    >) {
      if (slot.status === 'filled') requirements[fieldName] = slot.value;
    }
    for (const [fieldName, slot] of Object.entries(agentState.optionalFields) as Array<
      [string, FieldSlot]
    >) {
      if (slot.status === 'filled') requirements[fieldName] = slot.value;
    }

    // If the agent_tasks repo is wired, the persisted row's id is the source
    // of truth for taskId. Otherwise fall back to the in-memory id factory
    // (used by unit tests without a DB).
    let taskId: TaskId;
    if (this.deps.agentTasksFor) {
      const repo = this.deps.agentTasksFor(tenantId);
      const inserted = await repo.insertRoot({
        conversationId,
        agentId,
        agentCardVersion: entry.card.version,
        idempotencyKey: randomUUID(),
        requirementsSnapshot: requirements,
      });
      taskId = inserted.id;
      child.info({ taskId }, 'agent_task row inserted');
    } else {
      taskId = this.deps.newTaskId();
    }

    const message: A2AMessage = {
      taskId,
      tenantId,
      agentId,
      agentCardVersion: entry.card.version,
      requirements,
      createdAt: new Date().toISOString(),
    };

    child.info(
      {
        contract: 'A2AMessage',
        taskId,
        agentCardVersion: message.agentCardVersion,
        requirementKeys: Object.keys(requirements),
        requirementsPreview: Object.fromEntries(
          Object.entries(requirements).map(([k, v]) => [k, previewValue(v)]),
        ),
      },
      'orchestrator.dispatch.input',
    );

    await this.deps.store.recordDispatch(conversationId, agentId, taskId);
    this.taskOwnership.set(taskId, { conversationId, agentId });
    await this.deps.transport.dispatch(message);

    child.info(
      { contract: 'TaskId', taskId, transport: this.deps.transport.constructor.name },
      'orchestrator.dispatch.output',
    );

    // Queue an announce_dispatch decision so the next getNextDecision call
    // surfaces it once. Also notify the side-channel notifier immediately so
    // any subscribers wake up.
    const announcement: AnnounceDispatchDecision = {
      kind: 'announce_dispatch',
      agentId,
      taskId,
    };
    const bucket = this.pendingDispatches.get(conversationId) ?? [];
    bucket.push(announcement);
    this.pendingDispatches.set(conversationId, bucket);

    this.deps.notifier.notify(conversationId, announcement);
  }

  /**
   * Called by the transport when a task settles (succeeds or fails).
   * Wired at construction time in the bootstrapper (see test for the pattern).
   *
   * `deliverableIds` is supplied by the caller (the agent worker) when the
   * worker has already persisted the artifacts as `deliverables` rows. The
   * orchestrator does NOT persist deliverables itself — that's the worker's
   * job, since the worker is the one running the agent and producing the
   * artifacts. The orchestrator just threads the resulting ids into the
   * `announce_completion` decision so the chat layer can reference them.
   */
  onTaskSettled = async (
    taskId: TaskId,
    state: TaskState,
    deliverableIds: ReadonlyArray<DeliverableId> = [],
    context?: TaskSettlementContext,
  ): Promise<void> => {
    let owner = this.taskOwnership.get(taskId);
    if (!owner && context) {
      // Context comes only from the worker after it re-reads the canonical
      // task and resolves the conversation owner under tenant scope.
      await this.startConversation(
        context.conversationId as ConversationId,
        context.tenantId as UUID,
        context.ownerUserId as UUID,
      );
      owner = {
        conversationId: context.conversationId as ConversationId,
        agentId: context.agentId as AgentId,
      };
      this.taskOwnership.set(taskId, owner);
    }
    if (!owner) {
      log.warn(
        {
          op: 'onTaskSettled',
          taskId,
          status: state.status,
          knownTaskCount: this.taskOwnership.size,
        },
        'orchestrator.task.settled_unowned',
      );
      return; // task dispatched by something we don't manage (or already surfaced)
    }

    log.info(
      {
        op: 'onTaskSettled',
        taskId,
        conversationId: owner.conversationId,
        agentId: owner.agentId,
        status: state.status,
        deliverableCount: deliverableIds.length,
      },
      'orchestrator.task_settled.entered',
    );

    this.taskOwnership.delete(taskId);

    const tenantId = this.conversationTenants.get(owner.conversationId);
    const child = log.child({
      op: 'onTaskSettled',
      tenantId,
      conversationId: owner.conversationId,
      agentId: owner.agentId,
      taskId,
      status: state.status,
    });

    const artifactSummary =
      state.status === 'completed'
        ? state.result.artifacts.map((a) => ({ kind: a.kind, hasUrl: Boolean(a.url) }))
        : [];
    const errorSummary =
      state.status === 'failed'
        ? { kind: state.result.error.kind, message: state.result.error.message }
        : null;
    child.info(
      {
        contract: 'TaskState',
        status: state.status,
        artifactCount: artifactSummary.length,
        artifacts: artifactSummary,
        error: errorSummary,
      },
      'orchestrator.task_settled.input',
    );

    // Persist the terminal state if the agent_tasks repo is wired.
    if (this.deps.agentTasksFor && tenantId && !context?.durableSettlement) {
      const repo = this.deps.agentTasksFor(tenantId);
      try {
        if (state.status === 'completed') {
          await repo.markCompleted(taskId);
        } else if (state.status === 'failed') {
          await repo.markFailed(
            taskId,
            { kind: state.result.error.kind, message: state.result.error.message },
            'transient',
          );
        }
      } catch (err) {
        child.error({ err }, 'orchestrator.task.persist_failed');
      }
    }

    // Clear the in-flight marker on the agent state. Without this, the
    // planner's Rule 1 ("any agent has a dispatched-but-unsettled task ->
    // idle: awaiting_dispatch") fires forever after the first dispatch in a
    // conversation, masking subsequent ready-to-dispatch agents with a stale
    // "task_in_flight" reason. iterationCount stays incremented so
    // findAgentReadyToDispatch still treats this agent as already-handled
    // (re-runs are user-triggered iterations per §2.7, not auto-dispatch).
    if (!context?.durableSettlement) {
      try {
        await this.deps.store.clearDispatch(owner.conversationId, owner.agentId);
      } catch (err) {
        child.error({ err }, 'orchestrator.task.clear_dispatch_failed');
      }
    }

    const bucket = this.pendingCompletions.get(owner.conversationId) ?? [];
    bucket.push({ taskId, agentId: owner.agentId, state, deliverableIds });
    this.pendingCompletions.set(owner.conversationId, bucket);

    // Side-channel: surface artifacts to anyone subscribed (the SSE route).
    // Decisions stay pure; transports are responsible for the actual deliverables.
    const artifactCount =
      state.status === 'completed' ? state.result.artifacts.length : 0;
    if (
      this.deps.artifactNotifier &&
      state.status === 'completed' &&
      state.result.artifacts.length > 0
    ) {
      this.deps.artifactNotifier.publish({
        conversationId: owner.conversationId,
        agentId: owner.agentId,
        taskId,
        artifacts: state.result.artifacts,
      });
      child.info(
        {
          artifactCount: state.result.artifacts.length,
          deliverableCount: deliverableIds.length,
          notifierClass: this.deps.artifactNotifier.constructor.name,
        },
        'orchestrator.artifact.published',
      );
    } else {
      child.warn(
        {
          hasNotifier: Boolean(this.deps.artifactNotifier),
          status: state.status,
          artifactCount,
        },
        'orchestrator.artifact.publish_skipped',
      );
    }

    // Wake subscribers.
    const plan = await this.peekNextDecision(owner.conversationId);
    for (const decision of plan) {
      this.deps.notifier.notify(owner.conversationId, decision);
    }
    child.info(
      {
        contract: 'PlannerDecision[]',
        plan: plan.map((decision) => ({
          kind: decision.kind,
          agentId: 'agentId' in decision ? decision.agentId : undefined,
        })),
      },
      'orchestrator.task_settled.output',
    );
  };
}

interface PendingCompletion {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly state: TaskState;
  readonly deliverableIds: ReadonlyArray<DeliverableId>;
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  const json = JSON.stringify(value);
  return json && json.length > 80 ? `${json.slice(0, 77)}...` : json ?? '';
}
