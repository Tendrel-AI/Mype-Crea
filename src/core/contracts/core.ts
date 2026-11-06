/**
 * MYPES Platform — OrchestratorCore interface
 * ============================================
 *
 * The modality-blind core has exactly two responsibilities:
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

import type { ConversationId } from './ids';
import type { ConversationSnapshot } from './conversation';
import type { PlannerDecision } from './decisions';
import type { FieldDelta } from './deltas';

/**
 * A field value or `reset_field` that merge refused because the field is not
 * declared by a registered Agent Card or its value fails validation (KAN-44).
 * Names only: the offending value stays in the caller's delta.
 */
export interface RejectedFieldWrite {
  readonly agentId: string;
  readonly fieldName: string;
  readonly target: 'value' | 'reset';
  readonly reason: 'unknown_agent' | 'unknown_field' | 'invalid_value';
}

export interface AppliedDelta {
  readonly snapshot: ConversationSnapshot;
  /** What merge refused; the controller records it in the rejection log (KAN-44). */
  readonly rejected: ReadonlyArray<RejectedFieldWrite>;
}

export interface OrchestratorCore {
  /**
   * Merge a FieldDelta into the conversation's state.
   *
   * Resolves to the updated state snapshot and the writes merge refused
   * (KAN-44); adapters pull decisions separately.
   *
   * Side effects:
   *   - Writes the delta to the conversation history (append-only).
   *   - Updates per-agent requirement fulfillment.
   *   - Never dispatches an agent (KAN-28): generation starts only through a
   *     typed deliverable command (`DeliverableCommandPort.executeCommand`).
   *   - May emit a Postgres NOTIFY so subscribed output adapters wake up.
   */
  applyDelta(delta: FieldDelta): Promise<AppliedDelta>;

  /**
   * Return the planner's current ordered plan for the conversation. The array
   * is the bundle of decisions the Responder should render in this turn, in
   * order — typically one entry, but a single turn may bundle e.g.
   * `[announce_dispatch, request_fields]` so the Responder confirms a dispatch
   * and immediately pivots to the next batch of questions.
   *
   * Idempotent and side-effect-free, except that calling this method drains
   * the orchestrator's pending dispatch and completion queues so each
   * announcement is surfaced exactly once.
   */
  getNextDecision(conversationId: ConversationId): Promise<ReadonlyArray<PlannerDecision>>;

  /** Read decisions without consuming completion/dispatch announcements. */
  peekNextDecision(conversationId: ConversationId): Promise<ReadonlyArray<PlannerDecision>>;

  /** Acknowledge announcements only after their durable turn checkpoint. */
  acknowledgeDecisions(
    conversationId: ConversationId,
    decisions: ReadonlyArray<PlannerDecision>,
  ): Promise<void>;

  /**
   * Return a snapshot of conversation state (for debugging, tests, and the
   * admin dashboard — never for rendering user-facing UI).
   */
  getSnapshot(conversationId: ConversationId): Promise<ConversationSnapshot>;
}
