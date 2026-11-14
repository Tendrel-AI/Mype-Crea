/**
 * MYPES Platform — Approval port (KAN-28 / KAN-34 / KAN-65)
 * ==========================================================
 *
 * «Aprobar» is the single select-and-approve act per deliverable type
 * (KAN-65 Option A). Approving another candidate replaces the current
 * approval; the store records every approval/replacement (append-only
 * history, KAN-34) and, in the SAME atomic write, marks the dependent kinds
 * stale (RF-07). Nothing is regenerated automatically.
 *
 * Since KAN-35 the marks are an append-only record of the event; staleness
 * is computed from the inputs each candidate recorded
 * (`deriveStaleCandidateIds` in ./orchestrator/deliverable-state.ts). The
 * marks still decide for tasks created before KAN-35: a kind is stale while
 * its newest mark is newer than its newest approval. Approval timestamps are
 * never compared, so two racing approvals cannot produce a false overlay.
 *
 * This is the contract shared with the KAN-34 persistence work. The core
 * depends only on `IApprovalStore`; implementations:
 *   - `InMemoryApprovalStore` (below) — unit tests and the in-memory core.
 *   - `createPostgresApprovalStore` (src/repos/approval-store.ts) — production,
 *     wired at `createApprovalStore` in ./orchestrator/runtime.ts: append-only
 *     `deliverable_approvals` history and `deliverable_stale_marks` events,
 *     keeping `deliverables.selected_at` / `superseded_by` current, all inside
 *     one tenant transaction.
 *
 * Concurrency: `expectedApprovedId` is the approved deliverable the client
 * saw (or null). A mismatch with the current approval is rejected as
 * `stale` (KAN-34 AC3) and nothing changes.
 *
 * Atomicity (KAN-34): `approve` records the approval and the stale marks of
 * `dependentKinds` together or not at all. If writing a mark fails, the
 * approval is rolled back and the error propagates.
 */

export type ApproveResult =
  | { ok: true; approvalId: string; replacedDeliverableId: string | null }
  | { ok: false; reason: 'stale' | 'not_candidate' | 'not_found' };

export interface ApproveInput {
  readonly conversationId: string;
  readonly deliverableKind: string;
  readonly deliverableId: string;
  /** The approved deliverable the client saw (null when none was approved). */
  readonly expectedApprovedId: string | null;
  /**
   * Kinds that depend on `deliverableKind` (transitively). When a new
   * approval is recorded they are marked stale in the same atomic write. An
   * idempotent re-approval of the current deliverable records nothing and
   * marks nothing. Must not contain `deliverableKind` itself.
   */
  readonly dependentKinds: ReadonlyArray<string>;
  /**
   * The kind is brand-level (KAN-89): the approval also becomes the brand's result, and
   * `expectedApprovedId` is compared with it. Derived from the Agent Card, never from the client.
   */
  readonly brandLevel?: boolean;
}

/** What a user-brought version is made of (KAN-89): the typed text, or the brand's uploaded logo. */
export type OwnSource = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'brand_logo' };

export interface ApproveOwnInput {
  readonly conversationId: string;
  readonly agentId: string;
  readonly agentCardVersion: string;
  readonly deliverableKind: string;
  readonly source: OwnSource;
  /** The approved deliverable the client saw (the brand's result when there is one), or null. */
  readonly expectedApprovedId: string | null;
  readonly dependentKinds: ReadonlyArray<string>;
}

/** `missing_source`: the source does not exist (no uploaded brand logo). */
export type ApproveOwnResult = ApproveResult | { ok: false; reason: 'missing_source' };

export interface ApprovedRecord {
  readonly deliverableKind: string;
  readonly deliverableId: string;
  /** Informational only: never compared to derive staleness. */
  readonly approvedAt: string;
}

export interface IApprovalStore {
  /** Approve and mark `dependentKinds` stale, atomically. */
  approve(input: ApproveInput): Promise<ApproveResult>;
  /**
   * Store a version the user brought («Usar mi …», F12 / KAN-89) and approve it, origin `user`, with no
   * generation and no cost. Absent on stores that cannot do it (the command is then refused).
   */
  approveOwn?(input: ApproveOwnInput): Promise<ApproveOwnResult>;
  /**
   * Current approval per kind. In a conversation of a brand, the brand's result wins for brand-level
   * kinds (KAN-89), even when it was approved in another conversation.
   */
  getApproved(conversationId: string): Promise<ReadonlyArray<ApprovedRecord>>;
  /**
   * Kinds whose newest stale mark is newer than their newest approval. The
   * core feeds them into the pure state function, which uses them only for
   * tasks created before KAN-35 (newer ones compare their recorded inputs).
   */
  getStaleKinds(conversationId: string): Promise<ReadonlyArray<string>>;
}

/** Candidate lookup the in-memory store needs to answer `not_candidate` / `not_found`. */
export interface ApprovalCandidateLookup {
  /** Returns the kind of the deliverable in this conversation, or null when unknown. */
  kindOf(conversationId: string, deliverableId: string): Promise<string | null> | string | null;
}

interface ApprovalRecord {
  readonly approvalId: string;
  readonly deliverableKind: string;
  readonly deliverableId: string;
  readonly replacedDeliverableId: string | null;
  readonly approvedAt: string;
}

/**
 * In-memory approval store with the same semantics the Postgres adapter
 * provides: one approved deliverable per (conversation, kind), atomic
 * replace + stale marks, append-only history, `expectedApprovedId`
 * concurrency.
 */
export class InMemoryApprovalStore implements IApprovalStore {
  private readonly history = new Map<string, ApprovalRecord[]>();
  private readonly staleKinds = new Map<string, Set<string>>();
  private sequence = 0;

  constructor(
    private readonly candidates: ApprovalCandidateLookup,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async approve(input: ApproveInput): Promise<ApproveResult> {
    const kind = await this.candidates.kindOf(input.conversationId, input.deliverableId);
    if (kind === null) return { ok: false, reason: 'not_found' };
    if (kind !== input.deliverableKind) return { ok: false, reason: 'not_candidate' };

    const current = this.currentFor(input.conversationId, input.deliverableKind);
    const currentId = current?.deliverableId ?? null;
    if (currentId !== input.expectedApprovedId) return { ok: false, reason: 'stale' };
    // Re-approving the current deliverable is an idempotent no-op (KAN-34).
    if (current && currentId === input.deliverableId) {
      return { ok: true, approvalId: current.approvalId, replacedDeliverableId: null };
    }

    // Stage both writes, then commit them together: a failure while staging
    // the stale marks leaves the approval untouched (the Postgres adapter gets
    // the same guarantee from its single transaction).
    const record: ApprovalRecord = {
      approvalId: `approval-${this.sequence + 1}`,
      deliverableKind: input.deliverableKind,
      deliverableId: input.deliverableId,
      replacedDeliverableId: currentId,
      approvedAt: this.now().toISOString(),
    };
    const nextStale = new Set(this.staleKinds.get(input.conversationId) ?? []);
    // A fresh approval of this kind clears its own stale mark.
    nextStale.delete(input.deliverableKind);
    this.stageStaleMarks(nextStale, input.deliverableKind, input.dependentKinds);

    this.sequence += 1;
    const bucket = this.history.get(input.conversationId) ?? [];
    bucket.push(record);
    this.history.set(input.conversationId, bucket);
    this.staleKinds.set(input.conversationId, nextStale);
    return { ok: true, approvalId: record.approvalId, replacedDeliverableId: currentId };
  }

  async getApproved(conversationId: string): Promise<ReadonlyArray<ApprovedRecord>> {
    const latestByKind = new Map<string, ApprovalRecord>();
    for (const record of this.history.get(conversationId) ?? []) {
      latestByKind.set(record.deliverableKind, record);
    }
    return [...latestByKind.values()]
      .sort((a, b) => (a.deliverableKind < b.deliverableKind ? -1 : 1))
      .map(({ deliverableKind, deliverableId, approvedAt }) => ({ deliverableKind, deliverableId, approvedAt }));
  }

  async getStaleKinds(conversationId: string): Promise<ReadonlyArray<string>> {
    return [...(this.staleKinds.get(conversationId) ?? [])].sort();
  }

  /** Append-only approval trail (tests and debugging). */
  historyFor(conversationId: string): ReadonlyArray<ApprovalRecord> {
    return [...(this.history.get(conversationId) ?? [])];
  }

  /**
   * Add the dependents' marks to the staged set. Marks may exist for kinds
   * with nothing approved (KAN-34); the state function shows «obsoleto» only
   * as an overlay on an approved kind, and a later approval of the kind
   * clears its mark. Throws (before anything is committed) when a dependent
   * is the approved kind itself.
   */
  protected stageStaleMarks(staged: Set<string>, approvedKind: string, dependentKinds: ReadonlyArray<string>): void {
    for (const kind of dependentKinds) {
      if (kind === approvedKind) {
        throw new Error(`approvals.approve: a kind cannot depend on itself: ${kind}`);
      }
      staged.add(kind);
    }
  }

  private currentFor(conversationId: string, kind: string): ApprovalRecord | undefined {
    const records = this.history.get(conversationId) ?? [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].deliverableKind === kind) return records[i];
    }
    return undefined;
  }
}
