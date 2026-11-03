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
 * all logic lives in merge.ts, planner.ts, deliverable-state.ts and
 * deliverable-commands.ts. If you find yourself adding an `if` about a
 * specific field or agent here, stop — it belongs somewhere else.
 *
 * KAN-28 (KAN-64 Option B): the core no longer dispatches after a merge.
 * `applyDelta` only merges and re-plans; a generation starts exclusively
 * through `executeCommand` (typed «Generar» / «Iterar» / «Reintentar»), which
 * re-validates against the pure per-deliverable state function and then
 * dispatches through `IAgentTransport`.
 *
 * See also:
 *   - contracts.ts                (OrchestratorCore interface)
 *   - merge.ts / planner.ts       (the two stages wired below)
 *   - local-adapter.ts            (the IAgentTransport implementation)
 *   - docs/agents/architecture.md  (rules 1, 2: modality-blind core)
 */

import type {
  AppliedDelta,
  AgentId,
  AnnounceDispatchDecision,
  ConversationId,
  ConversationSnapshot,
  DeliverableCommand,
  DeliverableCommandPort,
  DeliverableCommandResult,
  DeliverableId,
  DeliverableStateView,
  FieldDelta,
  OrchestratorCore,
  PlannerDecision,
  TaskId,
  UUID,
} from '../contracts';
import type { A2AMessage, IAgentTransport, TaskState } from '../agent-types';
import { InMemoryApprovalStore, type IApprovalStore } from '../approvals';
import { classifyTaskError } from '../task-errors';
import { loggerFor } from '../../services/logger';
import type { AgentRegistry } from './agent-registry';
import type { TaskSettlementContext } from './runtime-config';
import type { IConversationStore } from './in-memory-store';
import { mergeFieldDelta, rejectedWrites } from './merge';
import { planNextDecision } from './planner';
import type { IArtifactNotifier } from './artifact-notifier';
import { InProcessNotificationChannel, type NotificationChannel } from './notification-channels';
import type { IterationRefinement } from '../refinement';
import type { UpstreamInput } from '../deliverable-inputs';
import {
  InMemoryDeliverableWorkflowStore,
  type IDeliverableWorkflowStore,
  type WorkflowTask,
} from './deliverable-workflow';
import {
  COMMAND_MESSAGES,
  commandFingerprint,
  deriveStatesFor,
  executeDeliverableCommand,
  type DeliverableCommandContext,
} from './deliverable-commands';

/** How many applied command results the in-process replay cache keeps. */
const COMMAND_REPLAY_CACHE_SIZE = 1000;


const log = loggerFor('orchestrator.core');

// ---------------------------------------------------------------------------
// Decision notifier — the `decision` kind of the notification contract
// ---------------------------------------------------------------------------

export interface IDecisionNotifier {
  notify(conversationId: ConversationId, decision: PlannerDecision): void;
  subscribe(
    conversationId: ConversationId,
    handler: (decision: PlannerDecision) => void,
  ): { dispose(): void };
}

/** Decision notifier over any `decision` channel (see notification-channels.ts). */
export class ChannelDecisionNotifier implements IDecisionNotifier {
  constructor(private readonly channel: NotificationChannel<'decision'>) {}

  notify(conversationId: ConversationId, decision: PlannerDecision): void {
    this.channel.publish({ conversationId, decision });
  }

  subscribe(
    conversationId: ConversationId,
    handler: (decision: PlannerDecision) => void,
  ): { dispose(): void } {
    return this.channel.subscribe(conversationId, (payload) => handler(payload.decision));
  }
}

/** In-process notifier (single-process dev/tests); Redis in production. */
export class InProcessDecisionNotifier extends ChannelDecisionNotifier {
  constructor() {
    super(new InProcessNotificationChannel('decision'));
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
   * Deliverable workflow store (tasks + candidates), scoped to the
   * conversation's tenant and owner. Production passes the Postgres adapter
   * over `agent_tasks` / `deliverables`; omitted -> one shared in-memory
   * store (unit tests).
   */
  readonly workflowFor?: (tenantId: UUID, userId: UUID) => IDeliverableWorkflowStore;
  /**
   * Approval store (KAN-34 port). Omitted -> one shared in-memory store whose
   * candidates are read from the workflow store.
   */
  readonly approvalsFor?: (tenantId: UUID, userId: UUID) => IApprovalStore;
  /**
   * Optional artifact notifier. When provided, onTaskSettled publishes the
   * artifacts produced by a completed task on this channel. The SSE/UI edge
   * subscribes here. Decision flow is unaffected when omitted.
   */
  readonly artifactNotifier?: IArtifactNotifier;
}

export class OrchestratorCoreImpl implements OrchestratorCore, DeliverableCommandPort {
  /** Conversations the core knows about — tenantId is recorded here so we don't re-ask every call. */
  private readonly conversationTenants = new Map<ConversationId, UUID>();

  /** Owner user per conversation, recorded with the tenant after the store authorized the actor. */
  private readonly conversationUsers = new Map<ConversationId, UUID>();

  /** Serializes commands per conversation inside this process. */
  private readonly commandLocks = new Map<ConversationId, Promise<unknown>>();

  /** Applied command results, keyed `${conversationId}:${commandId}` (idempotent replay). */
  private readonly appliedCommands = new Map<string, { readonly result: DeliverableCommandResult; readonly fingerprint: string }>();

  private readonly defaultWorkflow: InMemoryDeliverableWorkflowStore;
  private readonly defaultApprovals: InMemoryApprovalStore;

  /**
   * Map from taskId to the (conversationId, agentId) pair that dispatched it.
   * Populated in dispatchTask, consumed in onTaskSettled. Replaces what a
   * real Postgres implementation would do with a `tasks` table lookup.
   */
  private readonly taskOwnership = new Map<
    TaskId,
    { readonly conversationId: ConversationId; readonly agentId: AgentId }
  >();

  /**
   * Completed tasks whose announce_completion decision has not yet been
   * acknowledged. Cleared by acknowledgeDecisions. Failed tasks are never
   * queued here: no decision announces them (their failure is persisted on
   * agent_tasks and surfaced by the deliverable card and the durable
   * `task_failed` notice), so queueing them would only leak memory.
   */
  private readonly pendingCompletions = new Map<ConversationId, PendingCompletion[]>();

  /**
   * Dispatches that have happened but whose announce_dispatch decision has
   * not yet been surfaced through getNextDecision. The Responder reads these
   * once and the entry is removed; subsequent turns no longer re-announce.
   */
  private readonly pendingDispatches = new Map<ConversationId, AnnounceDispatchDecision[]>();

  constructor(private readonly deps: OrchestratorCoreDeps) {
    this.defaultWorkflow = new InMemoryDeliverableWorkflowStore(undefined, deps.newTaskId);
    this.defaultApprovals = new InMemoryApprovalStore({
      kindOf: async (conversationId, deliverableId) => {
        const candidates = await this.workflowForConversation(conversationId as ConversationId).listCandidates(
          conversationId as ConversationId,
        );
        return candidates.find((c) => c.deliverableId === deliverableId)?.kind ?? null;
      },
    });
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
    this.conversationUsers.set(conversationId, userId);
  }

  async applyDelta(delta: FieldDelta): Promise<AppliedDelta> {
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
    const merged = await mergeFieldDelta(delta, this.deps.store, this.deps.registry);
    const snapshotAfterMerge = (await this.deps.store.get(delta.conversationId))!;

    // 2) No dispatch here (KAN-64 Option B). A merge can only make a
    // deliverable `enabled`; the planner then offers «Generar» and the user
    // starts it with a typed command (`executeCommand`).

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
      },
      'orchestrator.output',
    );
    return { snapshot: snapshotAfterMerge, rejected: rejectedWrites(merged) };
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

    // 2. Include completion announcements. Only completed tasks are queued.
    // A failure has no PlannerDecision (owner decision 2026-10-25, KAN-58):
    // the deliverable card shows it with recovery commands, and its technical
    // detail reaches the chat only in developer mode, through the durable
    // `task_failed` notification (src/core/contracts/notifications.ts).
    const pending = this.pendingCompletions.get(conversationId);
    if (pending && pending.length > 0) {
      for (const next of pending) {
        child.info(
          {
            agentId: next.agentId,
            taskId: next.taskId,
            artifactCount: next.artifacts.length,
          },
          'orchestrator.decision.announce_completion',
        );
        plan.push({
          kind: 'announce_completion',
          agentId: next.agentId,
          taskId: next.taskId,
          deliverableIds: next.deliverableIds,
          artifacts: next.artifacts,
        });
      }
    }

    // 3. Ask the pure planner what the user-facing next step is. The planner
    // never produces announce_dispatch or announce_completion itself — those
    // are spliced in above by the orchestrator queues.
    const snapshot = await this.deps.store.get(conversationId);
    if (!snapshot) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const deliverableStates = await this.statesForPlanner(conversationId, snapshot);
    plan.push(...planNextDecision(snapshot, this.deps.registry, { deliverableStates }));

    return plan;
  }

  /**
   * Derived per-deliverable states for the planner's Rule 3. Reading them
   * is I/O, so it happens here and the planner receives plain data. On a
   * read failure the planner falls back to its snapshot-only predicate.
   */
  private async statesForPlanner(
    conversationId: ConversationId,
    snapshot: ConversationSnapshot,
  ): Promise<ReadonlyArray<DeliverableStateView> | undefined> {
    if (!this.conversationUsers.has(conversationId)) return undefined;
    try {
      return await deriveStatesFor(this.commandContext(conversationId, snapshot), conversationId);
    } catch (err) {
      log.warn({ err, conversationId }, 'orchestrator.deliverable_states.unavailable');
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Deliverable commands (KAN-28) — the only path that starts a generation
  // -------------------------------------------------------------------------

  async getDeliverableStates(conversationId: ConversationId): Promise<ReadonlyArray<DeliverableStateView>> {
    this.requireStarted(conversationId);
    return deriveStatesFor(this.commandContext(conversationId), conversationId);
  }

  async executeCommand(command: DeliverableCommand): Promise<DeliverableCommandResult> {
    this.requireStarted(command.conversationId);
    return this.withCommandLock(command.conversationId, async () => {
      const ctx = this.commandContext(command.conversationId);
      const cacheKey = `${command.conversationId}:${command.commandId}`;
      const cached = this.appliedCommands.get(cacheKey);
      const fingerprint = commandFingerprint(command);
      if (cached) {
        const states = await deriveStatesFor(ctx, command.conversationId);
        // KAN-44: the same command id with another payload never applies and never replays.
        if (cached.fingerprint !== fingerprint) {
          return { ok: false, commandId: command.commandId, kind: command.kind, reason: 'invalid', message: COMMAND_MESSAGES.replayConflict, states };
        }
        return { ...cached.result, replayed: true, states };
      }
      const result = await executeDeliverableCommand(ctx, command);
      if (result.ok) this.rememberCommand(cacheKey, { result, fingerprint });
      return result;
    });
  }

  private requireStarted(conversationId: ConversationId): void {
    if (!this.conversationTenants.has(conversationId) || !this.conversationUsers.has(conversationId)) {
      throw new Error(`Conversation not started: ${conversationId}. Call startConversation() first.`);
    }
  }

  private async withCommandLock<T>(conversationId: ConversationId, run: () => Promise<T>): Promise<T> {
    const previous = this.commandLocks.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.commandLocks.set(conversationId, next);
    try {
      return await next;
    } finally {
      if (this.commandLocks.get(conversationId) === next) this.commandLocks.delete(conversationId);
    }
  }

  private rememberCommand(key: string, entry: { readonly result: DeliverableCommandResult; readonly fingerprint: string }): void {
    this.appliedCommands.set(key, entry);
    if (this.appliedCommands.size > COMMAND_REPLAY_CACHE_SIZE) {
      const oldest = this.appliedCommands.keys().next().value;
      if (oldest !== undefined) this.appliedCommands.delete(oldest);
    }
  }

  private workflowForConversation(conversationId: ConversationId): IDeliverableWorkflowStore {
    const tenantId = this.conversationTenants.get(conversationId);
    const userId = this.conversationUsers.get(conversationId);
    if (this.deps.workflowFor && tenantId && userId) return this.deps.workflowFor(tenantId, userId);
    return this.defaultWorkflow;
  }

  private approvalsForConversation(conversationId: ConversationId): IApprovalStore {
    const tenantId = this.conversationTenants.get(conversationId);
    const userId = this.conversationUsers.get(conversationId);
    if (this.deps.approvalsFor && tenantId && userId) return this.deps.approvalsFor(tenantId, userId);
    return this.defaultApprovals;
  }

  private commandContext(
    conversationId: ConversationId,
    knownSnapshot?: ConversationSnapshot,
  ): DeliverableCommandContext {
    return {
      specs: this.deps.registry.getDeliverableSpecs(),
      workflow: this.workflowForConversation(conversationId),
      approvals: this.approvalsForConversation(conversationId),
      loadSnapshot: async (id) => {
        if (knownSnapshot && id === conversationId) return knownSnapshot;
        return this.getSnapshot(id);
      },
      agentCardVersion: (agentId) => this.deps.registry.get(agentId).card.version,
      dispatch: (input) => this.dispatchTask(input),
      onCanceled: async ({ conversationId: id, agentId, taskId }) => {
        this.taskOwnership.delete(taskId);
        const queued = this.pendingDispatches.get(id);
        if (queued) {
          const remaining = queued.filter((decision) => decision.taskId !== taskId);
          if (remaining.length) this.pendingDispatches.set(id, remaining);
          else this.pendingDispatches.delete(id);
        }
        const snapshot = await this.deps.store.get(id);
        if (snapshot?.agentStates[agentId]?.lastDispatchedTaskId === taskId) {
          await this.deps.store.clearDispatch(id, agentId);
        }
      },
    };
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

  /**
   * Send a task the command handler has just persisted. Requirements were
   * built from the current brief by the handler; the refinement (Iterar) is
   * carried in `A2AMessage.iteration`, never mixed into the requirements.
   */
  private async dispatchTask(input: {
    readonly conversationId: ConversationId;
    readonly agentId: string;
    readonly task: WorkflowTask;
    readonly requirements: Record<string, unknown>;
    readonly upstream: Readonly<Record<string, UpstreamInput>>;
    readonly refinement: IterationRefinement | null;
  }): Promise<void> {
    const { conversationId, agentId, task, requirements, upstream, refinement } = input;
    const tenantId = this.conversationTenants.get(conversationId)!;
    const entry = this.deps.registry.get(agentId);
    const taskId = task.id;
    const child = log.child({ op: 'dispatchTask', tenantId, conversationId, agentId, taskId });

    const message: A2AMessage = {
      taskId,
      tenantId,
      agentId,
      agentCardVersion: entry.card.version,
      requirements,
      ...(Object.keys(upstream).length > 0 ? { upstream } : {}),
      ...(task.parentTaskId
        ? {
            iteration: {
              parentTaskId: task.parentTaskId,
              ...(refinement && Object.keys(refinement.parameterChanges).length > 0
                ? { parameterChanges: refinement.parameterChanges }
                : {}),
              ...(refinement && refinement.observations.length > 0 ? { observations: refinement.observations } : {}),
              ...(refinement ? { anchorDeliverableId: refinement.anchorDeliverableId } : {}),
            },
          }
        : {}),
      createdAt: new Date().toISOString(),
    };

    child.info(
      {
        contract: 'A2AMessage',
        taskId,
        agentCardVersion: message.agentCardVersion,
        iterationNumber: task.iterationNumber,
        iterationTrigger: task.iterationTrigger,
        requirementKeys: Object.keys(requirements),
        requirementsPreview: Object.fromEntries(
          Object.entries(requirements).map(([k, v]) => [k, previewValue(v)]),
        ),
      },
      'orchestrator.dispatch.input',
    );

    await this.deps.store.recordDispatch(conversationId, agentId, taskId);
    this.taskOwnership.set(taskId, { conversationId, agentId });

    // Queue the announcement before the transport can settle the task.
    const announcement: AnnounceDispatchDecision = { kind: 'announce_dispatch', agentId, taskId };
    const bucket = this.pendingDispatches.get(conversationId) ?? [];
    bucket.push(announcement);
    this.pendingDispatches.set(conversationId, bucket);

    try {
      await this.deps.transport.dispatch(message);
    } catch (err) {
      // The task row is persisted as `pending`; the periodic recovery
      // republishes pending tasks, and the user can still Cancelar it.
      child.error({ err }, 'orchestrator.dispatch.transport_failed');
    }

    child.info(
      { contract: 'TaskId', taskId, transport: this.deps.transport.constructor.name },
      'orchestrator.dispatch.output',
    );
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

    // Persist a non-durable settlement (LocalAdapter path) through the
    // workflow store. The durable worker path already settled the task,
    // inserted the deliverables and cleared the in-flight marker in one
    // transaction (`aiTurns.settleTaskAndEnqueue`).
    if (!context?.durableSettlement) {
      let applied = true;
      try {
        const spec = this.deps.registry.getDeliverableSpecs().find((s) => s.agentId === owner.agentId);
        const recorded = await this.workflowForConversation(owner.conversationId).recordSettlement({
          conversationId: owner.conversationId,
          taskId,
          agentId: owner.agentId,
          deliverableKind: spec?.deliverableKind ?? owner.agentId,
          status: state.status === 'completed' ? 'completed' : 'failed',
          artifacts: state.status === 'completed' ? state.result.artifacts : [],
          deliverableIds,
          ...(state.status === 'failed'
            ? {
                error: { kind: state.result.error.kind, message: state.result.error.message },
                errorCategory: classifyTaskError(state.result.error),
              }
            : {}),
        });
        applied = recorded.applied;
        if (recorded.deliverableIds.length > 0) deliverableIds = recorded.deliverableIds;
      } catch (err) {
        child.error({ err }, 'orchestrator.task.persist_failed');
      }
      if (!applied) {
        // The task was canceled (or settled elsewhere) before this result
        // arrived: drop it. The in-flight marker belongs to the cancel path.
        child.info({}, 'orchestrator.task.settlement_ignored');
        return;
      }

      // Clear the in-flight marker. iterationCount stays incremented, so the
      // planner's field-collection focus skips an already-generated agent.
      try {
        await this.deps.store.clearDispatch(owner.conversationId, owner.agentId);
      } catch (err) {
        child.error({ err }, 'orchestrator.task.clear_dispatch_failed');
      }
    }

    if (state.status === 'completed') {
      const bucket = this.pendingCompletions.get(owner.conversationId) ?? [];
      bucket.push({
        taskId,
        agentId: owner.agentId,
        artifacts: state.result.artifacts,
        deliverableIds,
      });
      this.pendingCompletions.set(owner.conversationId, bucket);
    } else if (state.status === 'failed') {
      // No decision announces a failure, so it is not queued (see pendingCompletions);
      // the durable `task_failed` notice and the deliverable card surface it.
      child.info(
        {
          errorKind: state.result.error.kind,
          errorCategory: classifyTaskError(state.result.error),
        },
        'orchestrator.task.failed_not_announced',
      );
    }

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
  readonly artifacts: Extract<TaskState, { status: 'completed' }>['result']['artifacts'];
  readonly deliverableIds: ReadonlyArray<DeliverableId>;
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  const json = JSON.stringify(value);
  return json && json.length > 80 ? `${json.slice(0, 77)}...` : json ?? '';
}
