/**
 * MYPES Platform — Field deltas and input/output adapter contracts
 * =================================================================
 *
 * `FieldDelta` is the universal input every input adapter produces. The
 * orchestrator core is modality-blind: it applies deltas without knowing
 * whether they came from chat, a form, or anything else.
 *
 * Adapter interfaces live here because:
 *   - InputAdapter produces FieldDelta values.
 *   - OutputAdapter consumes PlannerDecision values (imported from ./decisions).
 *
 * See `../contracts.ts` for the barrel re-export and the file-level rules:
 *   - Modality state belongs INSIDE adapters, never on FieldDelta.
 *   - The `source` field on FieldDelta is audit/debug only.
 */

import type { A2AArtifact } from '../agent-types';
import type {
  AdapterSource,
  AgentId,
  ConversationId,
  DeliverableId,
  FieldName,
  ISOTimestamp,
  TaskId,
} from './ids';
import type { PlannerDecision } from './decisions';

// Re-exported so callers can pull A2AArtifact from the contracts surface,
// preserving the original contracts.ts behavior.
export type { A2AArtifact };

// ---------------------------------------------------------------------------
// FieldDelta — the universal input
// ---------------------------------------------------------------------------

/**
 * A FieldDelta carries:
 *   - field values the user has disclosed (facts)
 *   - explicit commands the user has issued (intents)
 *
 * The orchestrator core applies deltas without branching on `source`.
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
 * Facts go in `fields` ("my industry is food"). Commands go here ("select the
 * second logo", "regenerate this with changes"). Keeping these separate
 * prevents the core from disambiguating between disclosure and instruction.
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
// Confidence thresholds (extraction policy, lives with the values they bound)
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
// Adapter interfaces
// ---------------------------------------------------------------------------

/**
 * An InputAdapter converts user input (chat text, form fields, voice, etc.)
 * into FieldDelta objects and pushes them into the orchestrator core.
 *
 * The adapter's responsibility ends at submit(). It does NOT wait for planner
 * decisions — that's the output adapter's job.
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
