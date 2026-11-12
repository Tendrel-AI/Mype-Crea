/**
 * MYPES Platform — Planner decisions
 * ===================================
 *
 * `PlannerDecision` is the Planner's answer to "what should the system do
 * next in this conversation?". Every output adapter renders these decisions
 * in its own modality — chat turns them into Spanish prose, a form renders
 * them as the next field or confirmation dialog.
 *
 * Decisions are semantic. They describe WHAT should happen, never HOW it
 * should look on screen.
 *
 * New PlannerDecision variants require a design discussion — the decision
 * set is intentionally bounded. See `../contracts.ts` for file-level rules.
 */

import type { A2AArtifact } from '../agent-types';
import type { DeliverableCommandKind } from './deliverables';
import type { AgentId, DeliverableId, FieldName, TaskId } from './ids';

// ---------------------------------------------------------------------------
// PlannerDecision — the universal output
// ---------------------------------------------------------------------------

export type PlannerDecision =
  | RequestFieldsDecision
  | ConfirmFieldsDecision
  | RequestSelectionDecision
  | OfferGenerationDecision
  | RequestUploadDecision
  | AnnounceDispatchDecision
  | AnnounceCompletionDecision
  | ReportDeliverableStatusDecision
  | AnnounceAllCompleteDecision;

/**
 * Ask the user for a small batch of required fields belonging to a single
 * focus agent. The Planner picks one focus agent per turn and bundles up to
 * `MAX_FIELD_BATCH_SIZE` of its missing required fields. Asking once unblocks
 * every agent that owns the same field name (the merge stage fans the answer
 * out across all owners).
 */
export interface RequestFieldsDecision {
  readonly kind: 'request_fields';
  readonly agentId: AgentId;
  readonly fields: ReadonlyArray<RequestFieldEntry>;
}

export interface RequestFieldEntry {
  readonly fieldName: FieldName;

  /** The human-facing hint text from the Agent Card's requirements extension. */
  readonly promptHint: string;

  /** If the user provided this field before and we're asking again (e.g. after a reset). */
  readonly previousValue?: unknown;

  /** For enum-typed fields, the set of valid options the UI can surface. */
  readonly examples?: ReadonlyArray<unknown>;
}

/** One stored-but-unconfirmed value of a `confirm_fields` decision. */
export interface ConfirmFieldEntry {
  readonly agentId: AgentId;
  readonly fieldName: FieldName;
  readonly pendingValue: unknown;
}

/**
 * Ask the user to confirm, in ONE turn, every value the system has stored but isn't confident in (D35).
 * A bare «sí» confirms all of them, a bare «no» resets all, a longer reply corrects what it restates.
 */
export interface ConfirmFieldsDecision {
  readonly kind: 'confirm_fields';
  /** Lex-sorted by (agentId, fieldName); one entry per field name. */
  readonly entries: ReadonlyArray<ConfirmFieldEntry>;

  /** Why confirmation is needed — informs how the adapter phrases the confirmation. */
  readonly reason: 'low_confidence' | 'conflict' | 'high_stakes';
}

/**
 * Ask the user to pick one deliverable from a set. Emitted when an agent has
 * produced multiple iterations and a downstream consumer (another agent or
 * the final package) requires a committed choice.
 */
export interface RequestSelectionDecision {
  readonly kind: 'request_selection';
  readonly agentId: AgentId;
  readonly candidateDeliverableIds: ReadonlyArray<DeliverableId>;
}

/**
 * Every precondition of a deliverable is met and nothing was generated yet
 * (state `enabled`, KAN-64). Generation never starts on its own: the
 * Responder only tells the user that the «Generar» button is ready, e.g.
 * «Ya tienes todo listo para tu logo. Cuando quieras, toca el botón Generar.»
 */
export interface OfferGenerationDecision {
  readonly kind: 'offer_generation';
  readonly agentId: AgentId;
  /** Deliverable kind from the Agent Card's `mypes:deliverable` (e.g. "logo"). */
  readonly deliverableKind: string;
}

/**
 * D34: an in-scope deliverable needs a file upload (Agent Card `mypes:requirements.uploads`) and the
 * conversation has fewer than `min`. The user has a panel button to upload it.
 */
export interface RequestUploadDecision {
  readonly kind: 'request_upload';
  readonly agentId: AgentId;
  readonly deliverableKind: string;
  /** `brand_files.kind` being asked for (e.g. "lab_report"). */
  readonly uploadKind: string;
  /** The human-facing hint from the Agent Card. */
  readonly promptHint: string;
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
  /**
   * The artifacts the agent returned. Image/url artifacts surface in the side
   * panel; text artifacts (`kind === 'text'` with a string `inline`) are what
   * the Responder enumerates inline in the chat reply. Without this payload
   * the Responder cannot present deliverable contents — it is bounded to the
   * decision and "the panel will show it" is the only thing it can say.
   */
  readonly artifacts: ReadonlyArray<A2AArtifact>;
}

/**
 * A deliverable is waiting on the user or on the system (generating, in review,
 * failed) and there is nothing to ask. The Responder tells the user what to do
 * in the panel; it never asks a question the system cannot act on (KAN-91).
 */
export interface ReportDeliverableStatusDecision {
  readonly kind: 'report_deliverable_status';
  readonly agentId: AgentId;
  readonly deliverableKind: string;
  readonly state: 'generating' | 'in_review' | 'failed';
  /** Panel commands the user can use now (from the derived state), in DELIVERABLE_COMMAND_ORDER. */
  readonly allowedCommands: ReadonlyArray<DeliverableCommandKind>;
}

/**
 * Terminal state: every required field for every registered agent has been
 * collected and every agent has either been dispatched or completed. The
 * Responder closes the wizard step and invites the user to the next phase.
 */
export interface AnnounceAllCompleteDecision {
  readonly kind: 'announce_all_complete';
}

// ---------------------------------------------------------------------------
// Planner constants (live with the decisions they constrain)
// ---------------------------------------------------------------------------

/**
 * Maximum number of fields the Planner bundles into a single `request_fields`
 * decision. Keeps the Responder's reply natural ("a couple of questions at a
 * time") and prevents the user from being walled with the union of every
 * agent's requirements at once.
 */
export const MAX_FIELD_BATCH_SIZE = 2;

// ---------------------------------------------------------------------------
// Type guards (used by Planner implementations and tests)
// ---------------------------------------------------------------------------

export function isRequestFields(d: PlannerDecision): d is RequestFieldsDecision {
  return d.kind === 'request_fields';
}
export function isConfirmFields(d: PlannerDecision): d is ConfirmFieldsDecision {
  return d.kind === 'confirm_fields';
}
export function isRequestSelection(d: PlannerDecision): d is RequestSelectionDecision {
  return d.kind === 'request_selection';
}
export function isOfferGeneration(d: PlannerDecision): d is OfferGenerationDecision {
  return d.kind === 'offer_generation';
}
export function isRequestUpload(d: PlannerDecision): d is RequestUploadDecision {
  return d.kind === 'request_upload';
}
export function isAnnounceDispatch(d: PlannerDecision): d is AnnounceDispatchDecision {
  return d.kind === 'announce_dispatch';
}
export function isAnnounceCompletion(d: PlannerDecision): d is AnnounceCompletionDecision {
  return d.kind === 'announce_completion';
}
export function isReportDeliverableStatus(d: PlannerDecision): d is ReportDeliverableStatusDecision {
  return d.kind === 'report_deliverable_status';
}
export function isAnnounceAllComplete(d: PlannerDecision): d is AnnounceAllCompleteDecision {
  return d.kind === 'announce_all_complete';
}
