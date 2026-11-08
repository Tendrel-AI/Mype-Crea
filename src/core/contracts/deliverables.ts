/**
 * MYPES Platform — Deliverable workflow states and typed commands (KAN-28)
 * ========================================================================
 *
 * Decided in KAN-64 (Option B) and KAN-65 (A + R2), see
 * `pipeline/decisions/`. Generation never starts on its own: a deliverable
 * changes state only through a typed command (Generar, Iterar, Aprobar,
 * Reintentar, Cancelar) that the server re-validates against the pure state
 * function in `../orchestrator/deliverable-state.ts`.
 *
 * Identifiers are English. The Spanish product names from the KAN-64 table
 * map as follows:
 *
 *   blocked    = bloqueado        generate = Generar
 *   enabled    = habilitado       iterate  = Iterar
 *   generating = generando        approve  = Aprobar
 *   in_review  = en revisión      retry    = Reintentar
 *   approved   = aprobado         cancel   = Cancelar
 *   failed     = fallido          use_own  = Usar mi nombre / logo / lema (KAN-89)
 *   stale      = potencialmente desactualizado (overlay on `approved` / `in_review`)
 *
 * "Avanzar" is UI navigation only. It is not a command and never reaches
 * the server (KAN-64 decision 2).
 *
 * Commands are deliberately NOT `FieldDelta` intents: the Extractor output
 * can never carry them, so no chat text can start a paid generation
 * (RNF-07, P0428).
 */

import type { TaskErrorCategory } from '../task-errors';
import type { AgentId, ConversationId, DeliverableId, ISOTimestamp, TaskId, UUID } from './ids';

export type DeliverableStateKind =
  | 'blocked'
  | 'enabled'
  | 'generating'
  | 'in_review'
  | 'approved'
  | 'failed';

export type DeliverableCommandKind = 'generate' | 'iterate' | 'approve' | 'use_own' | 'retry' | 'cancel';

/** Canonical order used when listing allowed commands. */
export const DELIVERABLE_COMMAND_ORDER: ReadonlyArray<DeliverableCommandKind> = [
  'generate',
  'iterate',
  'approve',
  'use_own',
  'retry',
  'cancel',
];

/**
 * Upper bound, in Unicode code points, for the anchored observation of an
 * «Iterar» command (KAN-65 R2). Equals the KAN-34 storage cap
 * (`REFINEMENT_LIMITS.maxObservationChars` in src/core/refinement.ts). The
 * note is untrusted input; it is passed only to the target agent's handler
 * and is never parsed into facts or intents.
 */
export const MAX_ITERATION_OBSERVATION_LENGTH = 500;

/**
 * How a candidate was made (KAN-29), picked from its recorded artifact
 * metadata and task. Only these keys reach the client (never the raw prompt).
 * Fields an older row did not record are null / empty.
 */
export interface DeliverableProvenance {
  readonly promptVersion: string | null;
  readonly agentCardVersion: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  /** Brief fields the handler recorded as used (`metadata.inputs`), with their values. */
  readonly inputs: ReadonlyArray<{ readonly field: string; readonly value: string }>;
  /** `user` when the person brought this version («Usar mi …», KAN-89); `generated` otherwise (absent on older views). */
  readonly origin?: 'user' | 'generated';
  /** Approved upstream deliverables the task was created under (derived deliverables only). */
  readonly upstream: ReadonlyArray<{ readonly kind: string; readonly deliverableId: string; readonly value: string | null }>;
}

export interface DeliverableCandidateView {
  readonly deliverableId: DeliverableId;
  readonly taskId: TaskId;
  readonly contentUrl: string | null;
  readonly contentInline: Readonly<Record<string, unknown>> | null;
  /** Generation time (the deliverable row's creation). */
  readonly createdAt: ISOTimestamp;
  /**
   * False when the recorded safety verdict is not `passed` (KAN-33): the
   * candidate has no `contentUrl`, cannot be approved, and the UI shows the
   * review-path message instead of it.
   */
  readonly approvable: boolean;
  /**
   * 1-based ordinal of the producing task among this type's non-canceled
   * tasks, in creation order (KAN-29). Null if that task is not listed.
   */
  readonly iteration: number | null;
  /** RF-07 (KAN-35): this candidate was generated from inputs that changed since. */
  readonly stale: boolean;
  readonly provenance: DeliverableProvenance;
}

/**
 * Server-derived state of one deliverable type in one conversation. The UI
 * renders buttons from `allowedCommands`, but that is advisory only: every
 * command is re-validated against a freshly derived view (P0644, P0456).
 */
export interface DeliverableStateView {
  readonly agentId: AgentId;
  readonly deliverableKind: string;
  /**
   * `brand`: the name, logo and tagline belong to the brand and are approved once for all its
   * conversations (KAN-89); `product`: made per conversation.
   */
  readonly level?: 'brand' | 'product';
  /**
   * A brand-level deliverable seen from a product conversation: read-only here (no command is ever
   * allowed); it is completed, and approved, in the brand's chat (KAN-89).
   */
  readonly inheritedFromBrand?: boolean;
  readonly state: DeliverableStateKind;
  /**
   * «Potencialmente desactualizado» overlay (RF-07, KAN-35) on `approved` or
   * `in_review`: the current candidate (approved, else newest) was generated
   * from inputs that changed since — a brief field it used or an upstream
   * approval it was created under. Computed from recorded inputs, never
   * stored and never derived from timestamps. Nothing is regenerated.
   */
  readonly stale: boolean;
  readonly allowedCommands: ReadonlyArray<DeliverableCommandKind>;
  /** Required brief fields that are not `filled` yet, sorted. */
  readonly missingFields: ReadonlyArray<string>;
  /** Upstream deliverable kinds (dependency map) without a current approval, sorted. */
  readonly missingUpstream: ReadonlyArray<string>;
  /** `iteration`: same ordinal as `DeliverableCandidateView.iteration` (KAN-29). */
  readonly activeTask: { readonly taskId: TaskId; readonly status: 'pending' | 'in_progress'; readonly iteration: number } | null;
  readonly lastFailure: {
    readonly taskId: TaskId;
    readonly iteration: number;
    readonly errorCategory: TaskErrorCategory | null;
    /** The failed task's `error.kind` (e.g. `usage_limited`), so the card can explain it. */
    readonly errorKind: string | null;
    /**
     * True only for `transient` failures: an identical retry is expected to
     * succeed. Reintentar itself is offered for every category (KAN-58); the
     * recovery commands are in `allowedCommands`.
     */
    readonly retryable: boolean;
  } | null;
  readonly candidates: ReadonlyArray<DeliverableCandidateView>;
  readonly approvedDeliverableId: DeliverableId | null;
  /**
   * Opaque, deterministic token of the facts this view was derived from. A
   * command must echo it; a mismatch means the client acted on a stale view.
   */
  readonly stateToken: string;
}

interface CommandBase {
  /** Client-generated UUID. Replaying the same id never repeats the effect. */
  readonly commandId: UUID;
  readonly conversationId: ConversationId;
  readonly agentId: AgentId;
  /** State the client saw when the user acted. */
  readonly expectedState: DeliverableStateKind;
  /** `stateToken` of the view the client rendered. */
  readonly stateToken: string;
}

export type DeliverableCommand =
  | (CommandBase & { readonly kind: 'generate' })
  | (CommandBase & {
      readonly kind: 'iterate';
      /** Candidate the refinement is anchored to. Defaults to the approved, else the newest candidate. */
      readonly deliverableId?: DeliverableId;
      /** Short anchored observation (KAN-65 R2), at most MAX_ITERATION_OBSERVATION_LENGTH code points. */
      readonly observation?: string;
      /** Iteration-local panel parameter overrides (KAN-34 caps). Never written to the brief. */
      readonly parameterChanges?: Readonly<Record<string, string | number | boolean>>;
    })
  | (CommandBase & {
      readonly kind: 'approve';
      readonly deliverableId: DeliverableId;
      /** Currently approved deliverable the client saw, or null (KAN-34 AC3). */
      readonly expectedApprovedId: DeliverableId | null;
    })
  | (CommandBase & {
      readonly kind: 'use_own';
      /** The text of «Usar mi nombre / lema». Absent for «Usar mi logo», which takes the brand's uploaded logo. */
      readonly value?: string;
    })
  | (CommandBase & { readonly kind: 'retry'; readonly failedTaskId: TaskId })
  | (CommandBase & { readonly kind: 'cancel'; readonly taskId: TaskId });

export type DeliverableCommandRejection = 'stale' | 'not_allowed' | 'not_found' | 'invalid';

export type DeliverableCommandResult =
  | {
      readonly ok: true;
      readonly commandId: UUID;
      readonly kind: DeliverableCommandKind;
      /** Task created (generate/iterate/retry) or canceled (cancel). */
      readonly taskId?: TaskId;
      readonly approvalId?: string;
      /**
       * True when nothing was applied because the effect already holds: the
       * same command id was replayed, or the requested approval is already
       * the current one (no-op re-approval). Nothing is ever repeated.
       */
      readonly replayed: boolean;
      readonly states: ReadonlyArray<DeliverableStateView>;
    }
  | {
      readonly ok: false;
      readonly commandId: UUID;
      readonly kind: DeliverableCommandKind;
      readonly reason: DeliverableCommandRejection;
      /** Neutral Latin-American Spanish, tú, safe to show to the user. */
      readonly message: string;
      readonly states: ReadonlyArray<DeliverableStateView>;
    };

/** The command side of the core. Implemented by `OrchestratorCoreImpl`. */
export interface DeliverableCommandPort {
  getDeliverableStates(conversationId: ConversationId): Promise<ReadonlyArray<DeliverableStateView>>;
  executeCommand(command: DeliverableCommand): Promise<DeliverableCommandResult>;
}
