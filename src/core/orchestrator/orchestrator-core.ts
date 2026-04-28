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
 *   - .claude/skills/mypes-architecture/SKILL.md  (rules 1, 2: modality-blind core)
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AgentId,
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
import type { IConversationStore } from './in-memory-store';
import { mergeFieldDelta } from './merge';
import { findAgentReadyToDispatch, planNextDecision } from './planner';

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
    this.conversationTenants.set(conversationId, tenantId);
    await this.deps.store.getOrCreate(conversationId, tenantId, userId);
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
    child.info('orchestrator.applyDelta.start');

    // 1) Merge the delta into state.
    await mergeFieldDelta(delta, this.deps.store, this.deps.registry);

    // 2) Check whether any agent is now ready to dispatch.
    const snapshotAfterMerge = (await this.deps.store.get(delta.conversationId))!;
    const orderedAgents = [...this.deps.registry.getFieldSchemas()].sort(
      (a, b) => a.displayOrder - b.displayOrder,
    );
    const readyAgentId = findAgentReadyToDispatch(snapshotAfterMerge, orderedAgents);

    if (readyAgentId) {
      child.info({ agentId: readyAgentId }, 'orchestrator.dispatch.triggered');
      await this.dispatchAgent(delta.conversationId, readyAgentId);
      // dispatch will emit announce_dispatch via the notifier.
    }

    // 3) Emit the current planner decision so subscribers catch up.
    const decision = await this.getNextDecision(delta.conversationId);
    this.deps.notifier.notify(delta.conversationId, decision);

    child.info(
      { decisionKind: decision.kind, dispatched: Boolean(readyAgentId) },
      'orchestrator.applyDelta.complete',
    );
    return snapshotAfterMerge;
  }

  async getNextDecision(conversationId: ConversationId): Promise<PlannerDecision> {
    const tenantId = this.conversationTenants.get(conversationId);
    const child = log.child({ op: 'getNextDecision', tenantId, conversationId });

    // If there's a pending completion we haven't surfaced, surface it now.
    const pending = this.pendingCompletions.get(conversationId);
    if (pending && pending.length > 0) {
      const next = pending.shift()!;
      if (next.state.status === 'completed') {
        child.info(
          { agentId: next.agentId, taskId: next.taskId },
          'orchestrator.decision.announce_completion',
        );
        return {
          kind: 'announce_completion',
          agentId: next.agentId,
          taskId: next.taskId,
          // Deliverables persistence is out of scope for the harness;
          // we surface the task ID as a stand-in deliverable reference.
          // A real implementation would query the deliverables table here.
          deliverableIds: [next.taskId as unknown as DeliverableId],
        };
      }
      // Failed task — for now, fall through to the planner's view.
      // A later iteration may add an explicit 'announce_failure' decision kind.
      child.warn(
        { agentId: next.agentId, taskId: next.taskId },
        'orchestrator.decision.task_failed_falling_through',
      );
    }

    const snapshot = await this.deps.store.get(conversationId);
    if (!snapshot) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return planNextDecision(snapshot, this.deps.registry);
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

    await this.deps.store.recordDispatch(conversationId, agentId, taskId);
    this.taskOwnership.set(taskId, { conversationId, agentId });
    await this.deps.transport.dispatch(message);

    child.info({ taskId }, 'task dispatched');

    // Emit an immediate announce_dispatch decision.
    this.deps.notifier.notify(conversationId, {
      kind: 'announce_dispatch',
      agentId,
      taskId,
    });
  }

  /**
   * Called by the transport when a task settles (succeeds or fails).
   * Wired at construction time in the bootstrapper (see test for the pattern).
   */
  onTaskSettled = async (taskId: TaskId, state: TaskState): Promise<void> => {
    const owner = this.taskOwnership.get(taskId);
    if (!owner) {
      log.debug({ op: 'onTaskSettled', taskId }, 'orchestrator.task.settled_unowned');
      return; // task dispatched by something we don't manage (or already surfaced)
    }

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
    child.info('orchestrator.task.settled');

    // Persist the terminal state if the agent_tasks repo is wired.
    if (this.deps.agentTasksFor && tenantId) {
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

    const bucket = this.pendingCompletions.get(owner.conversationId) ?? [];
    bucket.push({ taskId, agentId: owner.agentId, state });
    this.pendingCompletions.set(owner.conversationId, bucket);

    // Wake subscribers.
    const decision = await this.getNextDecision(owner.conversationId);
    this.deps.notifier.notify(owner.conversationId, decision);
  };
}

interface PendingCompletion {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly state: TaskState;
}