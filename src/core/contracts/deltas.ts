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

  /** D41: dictionary code the Extractor mapped an `enum` field's text to (or `OTRO`). Read only by the facts writer. */
  readonly category?: string;

  /** Optional: the raw text/input that produced this value. Debug/audit only. */
  readonly rawInput?: string;

  /**
   * Optional precondition: apply only while the slot is still
   * `pending_confirmation` with this value. A «sí» to a confirm_fields sets it,
   * so a stale confirmation cannot overwrite a value accepted since (KAN-26).
   */
  readonly expectedPendingValue?: unknown;
}

/**
 * A UserIntent is an explicit command, not a fact.
 *
 * Facts go in `fields` ("my industry is food"). Commands go here ("select the
 * second logo", "regenerate this with changes"). Keeping these separate
 * prevents the core from disambiguating between disclosure and instruction.
 *
 * KAN-28: deliverable side effects (Generar, Iterar, Aprobar, Reintentar,
 * Cancelar) travel ONLY as typed `DeliverableCommand`s through the core's
 * command path. `select_deliverable`, `request_iteration` and `cancel_task`
 * below are legacy placeholders: merge records them as no-ops and nothing
 * dispatches, approves or cancels because of a `FieldDelta`.
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
      /** Same precondition as `FieldValueWithConfidence.expectedPendingValue` (a «no» with no correction). */
      readonly expectedPendingValue?: unknown;
    };

// ---------------------------------------------------------------------------
// RefinementSpec — structured iteration requests
// ---------------------------------------------------------------------------

/**
 * How the user wants an existing deliverable iterated.
 *
 * KAN-65 (R2): Phase 1 refinement uses structured side-panel parameters plus
 * short observations anchored to one candidate. Both are iteration-local and
 * never write the brief; they are stored only in the iteration task's
 * `requirements_snapshot.refinement` (KAN-34 shape and caps, see
 * `REFINEMENT_LIMITS` in contracts/deliverables.ts). Observations are
 * untrusted input passed only to the target agent's handler; the Extractor
 * never sees or produces them. Iterations are requested through the typed
 * «Iterar» command (`DeliverableCommand`), not through `FieldDelta`.
 */
export interface RefinementSpec {
  readonly parentTaskId: TaskId;

  /** Structured parameter overrides produced by the side-panel refinement UI. */
  readonly parameterChanges?: Readonly<Record<string, string | number | boolean>>;

  /** Anchored observations, at most `REFINEMENT_LIMITS.maxObservations` × `maxObservationChars`. */
  readonly observations?: ReadonlyArray<string>;

  /** Candidate the observations are anchored to. */
  readonly anchorDeliverableId?: DeliverableId | null;
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

  /** At or above this but below AUTO_ACCEPT: store but mark pending for confirm_fields. */
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
