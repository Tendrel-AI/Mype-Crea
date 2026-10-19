/**
 * MYPES Platform — Agent transport types
 * =======================================
 *
 * Location: src/core/agent-types.ts
 *
 * These types define the A2A-format envelopes used to communicate with
 * sub-agents, and the IAgentTransport interface the orchestrator calls to
 * dispatch tasks.
 *
 * The A2A envelope shape is intentionally minimal here. The real A2A spec
 * has more fields (streaming updates, richer artifact types, push
 * notifications); we encode the subset we actually use, and structure it
 * so expanding later is additive.
 *
 * See also:
 *   - contracts.ts   (FieldDelta, PlannerDecision — the OTHER side of the core)
 *   - docs/agents/architecture.md  (agent rules 6–8)
 */

import type { AgentId, TaskId, UUID, ISOTimestamp } from './contracts';

// ---------------------------------------------------------------------------
// A2A Message (what the core sends to an agent)
// ---------------------------------------------------------------------------

export interface A2AMessage {
  readonly taskId: TaskId;
  readonly tenantId: UUID;
  readonly agentId: AgentId;
  readonly agentCardVersion: string;

  /**
   * The fulfilled requirement values from the conversation state.
   * Shape matches the Agent Card's mypes:requirements definitions.
   */
  readonly requirements: Readonly<Record<string, unknown>>;

  /**
   * Set only when this is an iteration of a previous task. The agent handler
   * may use this to skip work it already did or to apply parameter deltas.
   */
  readonly iteration?: {
    readonly parentTaskId: TaskId;
    readonly parameterChanges?: Readonly<Record<string, unknown>>;
  };

  readonly createdAt: ISOTimestamp;
}

// ---------------------------------------------------------------------------
// A2A Task (what the agent returns)
// ---------------------------------------------------------------------------

export type A2ATaskResult =
  | {
      readonly status: 'completed';
      readonly taskId: TaskId;
      readonly artifacts: ReadonlyArray<A2AArtifact>;
      readonly completedAt: ISOTimestamp;
    }
  | {
      readonly status: 'failed';
      readonly taskId: TaskId;
      readonly error: {
        readonly kind: string;
        readonly message: string;
      };
      readonly completedAt: ISOTimestamp;
    };

export interface A2AArtifact {
  /** Stable kind string the output adapter can switch on (e.g. 'text', 'image', 'html'). */
  readonly kind: string;

  /** Inline payload for small artifacts. */
  readonly inline?: unknown;

  /** URL reference for large artifacts stored in blob storage. */
  readonly url?: string;

  /** Free-form metadata (e.g. mime type, dimensions). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Agent handler contract — what every sub-agent implements
// ---------------------------------------------------------------------------

/**
 * Every sub-agent exports a handler with exactly this signature.
 *
 * Location convention: agents/<agent-id>/handler.ts
 *
 * The handler is pure relative to its dependencies — whatever I/O it needs
 * (LLM provider, blob storage) is passed in `deps`, never imported as a
 * global. This is what makes handlers testable.
 */
export type AgentHandler<Deps = unknown> = (
  message: A2AMessage,
  deps: Deps,
) => Promise<A2ATaskResult>;

// ---------------------------------------------------------------------------
// IAgentTransport — how the orchestrator reaches any agent
// ---------------------------------------------------------------------------

/**
 * The single interface the core uses to dispatch tasks. Implementations:
 *   - LocalAdapter   (Phase 1 — direct function call over shared memory)
 *   - BullMQAdapter  (Phase 2 — stub for thesis, real later)
 *   - HttpA2AAdapter (Phase 3 — stub for thesis, real later)
 *
 * The async semantics are deliberate: dispatch returns a taskId, result
 * arrives separately via getResult. This shape is the same across all
 * transports, so extracting an agent from local to remote does not change
 * the core's calling code.
 */
export interface IAgentTransport {
  /**
   * Enqueue a task. Resolves as soon as the task is durably accepted
   * (not when it completes).
   */
  dispatch(message: A2AMessage): Promise<{ taskId: TaskId }>;

  /**
   * Look up a task's current state. For the local adapter this is an
   * in-memory lookup; for distributed adapters it queries shared storage
   * or the remote service.
   */
  getResult(taskId: TaskId): Promise<TaskState>;
}

export type TaskState =
  | { readonly status: 'pending' }
  | { readonly status: 'processing' }
  | { readonly status: 'completed'; readonly result: Extract<A2ATaskResult, { status: 'completed' }> }
  | { readonly status: 'failed'; readonly result: Extract<A2ATaskResult, { status: 'failed' }> };