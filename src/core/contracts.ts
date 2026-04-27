/**
 * MYPES Platform — Core Contracts
 * ================================
 *
 * This file is the single source of truth for the interfaces and data shapes
 * that cross the orchestrator's module boundaries. It is deliberately small
 * and deliberately opinionated.
 *
 * Location: src/core/contracts.ts
 *
 * RULES FOR MODIFYING THIS FILE
 * -----------------------------
 *   1. Anything added here becomes part of the public contract between
 *      the orchestrator core, input adapters, output adapters, and sub-agents.
 *      Treat additions as API changes.
 *   2. The orchestrator core MUST NOT depend on any concept not declared here
 *      (no direct references to chat, forms, Gemini, HTTP, etc.).
 *   3. Input and output adapters MUST NOT add fields to FieldDelta or
 *      PlannerDecision to encode modality-specific state. Modality state
 *      lives inside the adapter.
 *   4. New PlannerDecision variants require a design discussion — the
 *      decision set is intentionally bounded.
 *   5. The `source` field on FieldDelta is for audit and debugging only.
 *      The core MUST NOT branch on it.
 *
 * See also:
 *   - .claude/skills/mypes-architecture/SKILL.md  (architectural constitution)
 *   - docs/adr/                                    (architectural decisions)
 */

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/** ISO 8601 timestamp string. */
export type ISOTimestamp = string;

/** UUID v4 string. */
export type UUID = string;

/** Stable identifier for a registered sub-agent (e.g. "logo-agent"). */
export type AgentId = string;

/** Identifier for a named field defined in an Agent Card's requirements. */
export type FieldName = string;

/** Identifier for a running conversation (one per user session). */
export type ConversationId = UUID;

/** Identifier for a dispatched agent task. */
export type TaskId = UUID;

/** Identifier for a deliverable produced by a task. */
export type DeliverableId = UUID;

/** Identifier for the input adapter that produced a delta (e.g. "chat-es", "form-v1"). */
export type AdapterSource = string;

// ---------------------------------------------------------------------------
// FieldDelta — the universal input
// ---------------------------------------------------------------------------

/**
 * A FieldDelta is what every input adapter produces. It carries:
 *   - field values the user has disclosed (facts)
 *   - explicit commands the user has issued (intents)
 *
 * The orchestrator core is entirely modality-blind: it applies deltas
 * without knowing whether they came from chat, a form, or anything else.
 */
export interface FieldDelta {
  readonly conversationId: ConversationId;
  readonly source: AdapterSource;
  readonly timestamp: ISOTimestamp;

  /** Field values disclosed by the user, grouped by target agent. */
  readonly fields: FieldValues;

  /** Explicit commands the user issued alongside (or instead of) field values. */
  readonly intents?: ReadonlyArray<UserIntent>;
}

/**
 * Nested map: agentId -> fieldName -> value-with-confidence.
 *
 * Example:
 *   {
 *     "logo-agent": {
 *       "industry":  { value: "alimentos", confidence: 0.95 },
 *       "style":     { value: "minimalista", confidence: 0.70 }
 *     }
 *   }
 */
export interface FieldValues {
  readonly [agentId: AgentId]: {
    readonly [fieldName: FieldName]: FieldValueWithConfidence;
  };
}

export interface FieldValueWithConfidence {
  /** The extracted or provided value. Validated against the Agent Card schema at merge time. */
  readonly value: unknown;

  /**
   * Confidence in [0.0, 1.0].
   *   1.0  - literal user input (form field, selection click)
   *   0.9  - high-confidence LLM extraction from unambiguous prose
   *   0.6  - LLM extraction from ambiguous or hedged prose
   *  <0.6  - should not be stored; prefer re-asking explicitly
   */
  readonly confidence: number;

  /** Optional: the raw text/input that produced this value. Debug/audit only. */
  readonly rawInput?: string;
}

/**
 * A UserIntent is an explicit command, not a fact.
 *
 * Facts go in `fields` ("my industry is food"). Commands go here
 * ("select the second logo", "regenerate this with changes").
 *
 * Keeping these separate prevents the core from having to disambiguate
 * between disclosure and instruction — a recurring source of planner bugs.
 */
export type UserIntent =
  | {
      readonly kind: 'select_deliverable';
      readonly deliverableId: DeliverableId;
    }
  | {
      readonly kind: 'request_iteration';
      readonly agentId: AgentId;
      readonly refinement: RefinementSpec;
    }
  | {
      readonly kind: 'cancel_task';
      readonly taskId: TaskId;
    }
  | {
      readonly kind: 'reset_field';
      readonly agentId: AgentId;
      readonly fieldName: FieldName;
    };

// ---------------------------------------------------------------------------
// RefinementSpec — structured iteration requests
// ---------------------------------------------------------------------------

/**
 * How the user wants an existing deliverable iterated.
 *
 * v1 ships with `parameterChanges` populated by structured side-panel controls.
 * `freeTextHint` is reserved for a future natural-language refinement channel
 * and MUST NOT be the primary refinement mechanism in v1.
 */
export interface RefinementSpec {
  readonly parentTaskId: TaskId;

  /** Structured parameter overrides produced by the side-panel refinement UI. */
  readonly parameterChanges?: Readonly<Record<string, unknown>>;

  /** Optional free-text description of desired changes. Reserved for v2. */
  readonly freeTextHint?: string;
}

// ---------------------------------------------------------------------------
// PlannerDecision — the universal output
// ---------------------------------------------------------------------------

/**
 * A PlannerDecision is the Planner's answer to "what should the system do
 * next in this conversation?". Every output adapter renders these decisions
 * in its own modality — chat turns them into Spanish prose, a form renders
 * them as the next field or confirmation dialog.
 *
 * Decisions are semantic. They describe WHAT should happen, never HOW
 * it should look on screen.
 */
export type PlannerDecision =
  | RequestFieldDecision
  | ConfirmFieldDecision
  | RequestSelectionDecision
  | AnnounceDispatchDecision
  | AnnounceCompletionDecision
  | IdleDecision;

/** Ask the user for a required field that hasn't been provided yet. */
export interface RequestFieldDecision {
  readonly kind: 'request_field';
  readonly agentId: AgentId;
  readonly fieldName: FieldName;

  /** The human-facing hint text from the Agent Card's requirements extension. */
  readonly promptHint: string;

  /** If the user provided this field before and we're asking again (e.g. after a reset). */
  readonly previousValue?: unknown;

  /** For enum-typed fields, the set of valid options the UI can surface. */
  readonly examples?: ReadonlyArray<unknown>;
}

/** Ask the user to confirm a value the system has stored but isn't confident in. */
export interface ConfirmFieldDecision {
  readonly kind: 'confirm_field';
  readonly agentId: AgentId;
  readonly fieldName: FieldName;
  readonly pendingValue: unknown;

  /** Why confirmation is needed — informs how the adapter phrases the confirmation. */
  readonly reason: 'low_confidence' | 'conflict' | 'high_stakes';
}

/**
 * Ask the user to pick one deliverable from a set. Emitted when an agent
 * has produced multiple iterations and a downstream consumer (another agent
 * or the final package) requires a committed choice.
 */
export interface RequestSelectionDecision {
  readonly kind: 'request_selection';
  readonly agentId: AgentId;
  readonly candidateDeliverableIds: ReadonlyArray<DeliverableId>;
}

/** Inform the user (via the adapter) that a sub-agent task has just been dispatched. */
export interface AnnounceDispatchDecision {
  readonly kind: 'announce_dispatch';
  readonly agentId: AgentId;
  readonly taskId: TaskId;
}

/** Inform the user that a sub-agent has completed and produced one or more deliverables. */
export interface AnnounceCompletionDecision {
  readonly kind: 'announce_completion';
  readonly agentId: AgentId;
  readonly taskId: TaskId;
  readonly deliverableIds: ReadonlyArray<DeliverableId>;
}

/** No action needed right now. */
export interface IdleDecision {
  readonly kind: 'idle';
  readonly reason: 'all_complete' | 'awaiting_user' | 'awaiting_dispatch';
}

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

/**
 * Centralized confidence thresholds used by the State Merge and Planner stages.
 * These are intentionally NOT magic numbers scattered across the codebase.
 *
 * Tuning rules:
 *   - Adjustments require a note in the ADR log.
 *   - Tests covering the boundary cases must be updated simultaneously.
 */
export const CONFIDENCE_THRESHOLDS = {
  /** At or above this, store the value without prompting for confirmation. */
  AUTO_ACCEPT: 0.9,

  /** At or above this but below AUTO_ACCEPT: store but mark pending for confirm_field. */
  STORE_AND_CONFIRM: 0.6,

  /** Below STORE_AND_CONFIRM: discard the extracted value and re-ask explicitly. */
  // (implicit — anything < STORE_AND_CONFIRM)
} as const;

// ---------------------------------------------------------------------------
// OrchestratorCore — the modality-blind core
// ---------------------------------------------------------------------------

/**
 * The orchestrator core has exactly two responsibilities:
 *   1. Accept field deltas (from any input adapter) and merge them into state.
 *   2. Produce the current planner decision (consumed by any output adapter).
 *
 * Implementations MUST:
 *   - Be deterministic given the conversation state (pure-code planner).
 *   - Never make LLM calls (that's adapter territory).
 *   - Never branch on `source` for logic (audit-only field).
 *
 * Implementations MUST NOT:
 *   - Expose modality-specific methods (no `sendChatMessage`, no `renderForm`).
 *   - Hold streaming or real-time concerns (that's the output adapter).
 */
export interface OrchestratorCore {
  /**
   * Merge a FieldDelta into the conversation's state.
   *
   * Resolves to the updated state snapshot (useful for tests; adapters
   * typically ignore the return value and pull decisions separately).
   *
   * Side effects:
   *   - Writes the delta to the conversation history (append-only).
   *   - Updates per-agent requirement fulfillment.
   *   - May dispatch an agent if its requirements become fully satisfied.
   *   - May emit a Postgres NOTIFY so subscribed output adapters wake up.
   */
  applyDelta(delta: FieldDelta): Promise<ConversationSnapshot>;

  /**
   * Return the current planner decision for the conversation. Called by
   * output adapters whenever they need to know "what should I render next?".
   *
   * Idempotent and side-effect-free.
   */
  getNextDecision(conversationId: ConversationId): Promise<PlannerDecision>;

  /**
   * Return a snapshot of conversation state (for debugging, tests, and
   * the admin dashboard — never for rendering user-facing UI).
   */
  getSnapshot(conversationId: ConversationId): Promise<ConversationSnapshot>;
}

/**
 * A read-only view of the conversation's current state. Used by tests and
 * tooling; adapters should prefer `getNextDecision`.
 */
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

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

/**
 * An InputAdapter converts user input (chat text, form fields, voice, etc.)
 * into FieldDelta objects and pushes them into the orchestrator core.
 *
 * Examples:
 *   - ChatInputAdapter: runs Gemini Flash extractor on Spanish prose.
 *   - FormInputAdapter: reads submitted form values directly (confidence = 1.0).
 *   - WhatsAppInputAdapter: parses incoming messages via a hosted bot.
 *
 * The adapter's responsibility ends at submit(). It does NOT wait for
 * planner decisions — that's the output adapter's job.
 */
export interface InputAdapter {
  /** Stable identifier written into FieldDelta.source. */
  readonly id: AdapterSource;

  /**
   * Submit a delta. Resolves when the delta is durably accepted by the core
   * (not when planner processing completes).
   */
  submit(delta: FieldDelta): Promise<AdapterSubmitResult>;
}

export interface AdapterSubmitResult {
  readonly accepted: boolean;
  /** Populated only when accepted === false. */
  readonly reason?: string;
}

/**
 * An OutputAdapter subscribes to planner decisions and renders them in its
 * own modality.
 *
 * Examples:
 *   - ChatOutputAdapter: streams Spanish prose via Gemini Pro responder.
 *   - FormOutputAdapter: translates decisions into form UI state.
 *
 * The adapter chooses its own delivery mechanism (LISTEN/NOTIFY, polling,
 * WebSocket). The orchestrator core does not care.
 */
export interface OutputAdapter {
  readonly id: string;

  /**
   * Subscribe to planner decisions for a conversation. The handler is invoked
   * every time the decision changes (new dispatch, new completion, new
   * requested field, etc.).
   *
   * Returns a Subscription whose dispose() method stops delivery.
   */
  onDecision(
    conversationId: ConversationId,
    handler: (decision: PlannerDecision) => Promise<void>,
  ): Subscription;
}

export interface Subscription {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Type guards (exported for use in Planner implementations and tests)
// ---------------------------------------------------------------------------

export function isRequestField(d: PlannerDecision): d is RequestFieldDecision {
  return d.kind === 'request_field';
}
export function isConfirmField(d: PlannerDecision): d is ConfirmFieldDecision {
  return d.kind === 'confirm_field';
}
export function isRequestSelection(d: PlannerDecision): d is RequestSelectionDecision {
  return d.kind === 'request_selection';
}
export function isAnnounceDispatch(d: PlannerDecision): d is AnnounceDispatchDecision {
  return d.kind === 'announce_dispatch';
}
export function isAnnounceCompletion(d: PlannerDecision): d is AnnounceCompletionDecision {
  return d.kind === 'announce_completion';
}
export function isIdle(d: PlannerDecision): d is IdleDecision {
  return d.kind === 'idle';
}
