/**
 * Runtime composition root — decoupled from env, swappable in tests.
 *
 * `RuntimeConfig` is the SHAPE of the orchestrator's dependencies; `buildRuntime`
 * is the WIRING that turns those dependencies into a usable `Runtime`. The
 * production runtime singleton in `./runtime.ts` constructs a `RuntimeConfig`
 * from environment variables (Postgres, Redis, default notifiers) and hands it
 * to `buildRuntime`. Tests construct a `RuntimeConfig` with all-fake deps and
 * exercise the wired pipeline without booting any I/O.
 *
 * The `transportFactory` indirection exists because the transport needs an
 * `onTaskSettled` callback that closes back over the core that has yet to be
 * constructed. `buildRuntime` resolves that cycle internally.
 */
import { ChatInputAdapter } from '../../adapters/chat-input-adapter';
import { ChatOutputAdapter } from '../../adapters/chat-output-adapter';
import type { DeliverableId, TaskId, UUID } from '../contracts';
import type { IAgentTransport, TaskState } from '../agent-types';
import type { IApprovalStore } from '../approvals';
import type { IDeliverableWorkflowStore } from './deliverable-workflow';
import type { AgentRegistry } from './agent-registry';
import type { IConversationStore } from './in-memory-store';
import type { IArtifactNotifier } from './artifact-notifier';
import { type IDecisionNotifier, OrchestratorCoreImpl } from './orchestrator-core';

/** What `buildRuntime` returns — the wired set callers consume. */
export interface Runtime {
  readonly core: OrchestratorCoreImpl;
  readonly chatInputAdapter: ChatInputAdapter;
  readonly chatOutputAdapter: ChatOutputAdapter;
}

/**
 * Callback the transport (or worker) invokes when a dispatched task settles.
 * `deliverableIds` is empty for transports that don't persist deliverables
 * themselves (e.g. LocalAdapter in unit tests).
 */
export type OnTaskSettled = (
  taskId: TaskId,
  state: TaskState,
  deliverableIds: ReadonlyArray<DeliverableId>,
  context?: TaskSettlementContext,
) => Promise<void> | void;

/** Server-verified task ownership recovered from the canonical task/conversation rows. */
export interface TaskSettlementContext {
  readonly tenantId: UUID;
  readonly conversationId: UUID;
  readonly ownerUserId: UUID;
  readonly agentId: string;
  readonly durableSettlement?: true;
}

/** Inputs to `buildRuntime`. Every field is replaceable. */
export interface RuntimeConfig {
  readonly registry: AgentRegistry;
  readonly store: IConversationStore;
  readonly newTaskId: () => TaskId;
  readonly decisionNotifier: IDecisionNotifier;
  readonly artifactNotifier?: IArtifactNotifier;
  /** Deliverable workflow store (tasks + candidates); omitted -> in-memory. */
  readonly workflowFor?: (tenantId: UUID, userId: UUID) => IDeliverableWorkflowStore;
  /** Approval store (KAN-34 port); omitted -> in-memory. */
  readonly approvalsFor?: (tenantId: UUID, userId: UUID) => IApprovalStore;
  /**
   * Build the agent transport. The factory receives the unified
   * `onTaskSettled` callback; the transport (or any workers it spawns) must
   * invoke it whenever a task reaches a terminal state.
   */
  readonly transportFactory: (onTaskSettled: OnTaskSettled) => IAgentTransport;
}

/**
 * Wire a `RuntimeConfig` into an `OrchestratorCoreImpl` plus the two chat
 * adapters. The transport's `onTaskSettled` callback is bridged to
 * `core.onTaskSettled` via a closure, resolving the construction cycle.
 */
export function buildRuntime(config: RuntimeConfig): Runtime {
  let coreRef: OrchestratorCoreImpl | null = null;
  const onTaskSettled: OnTaskSettled = async (taskId, state, deliverableIds, context) => {
    await coreRef?.onTaskSettled(taskId, state, deliverableIds, context);
  };

  const transport = config.transportFactory(onTaskSettled);

  const core = new OrchestratorCoreImpl({
    store: config.store,
    registry: config.registry,
    transport,
    notifier: config.decisionNotifier,
    artifactNotifier: config.artifactNotifier,
    newTaskId: config.newTaskId,
    workflowFor: config.workflowFor,
    approvalsFor: config.approvalsFor,
  });
  coreRef = core;

  return {
    core,
    chatInputAdapter: new ChatInputAdapter(core, config.registry),
    chatOutputAdapter: new ChatOutputAdapter(config.registry),
  };
}
