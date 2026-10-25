/**
 * MYPES Platform — Approval port (KAN-28 / KAN-34 / KAN-65)
 * ==========================================================
 *
 * «Aprobar» is the single select-and-approve act per deliverable type
 * (KAN-65 Option A). Approving another candidate replaces the current
 * approval; the store records every approval/replacement (append-only
 * history, KAN-34) and the core asks it to mark dependents stale (RF-07).
 * Nothing is regenerated automatically.
 *
 * This is the contract shared with the KAN-34 persistence work. The core
 * depends only on `IApprovalStore`; implementations:
 *   - `InMemoryApprovalStore` (below) — unit tests and the in-memory core.
 *   - `SelectedAtApprovalStore` (src/core/orchestrator/selected-at-approval-store.ts)
 *     — TEMPORARY production adapter over `deliverables.selected_at` /
 *     `superseded_by`, until the KAN-34 Postgres adapter replaces it.
 *
 * Concurrency: `expectedApprovedId` is the approved deliverable the client
 * saw (or null). A mismatch with the current approval is rejected as
 * `stale` (KAN-34 AC3) and nothing changes.
 */

export type ApproveResult =
  | { ok: true; approvalId: string; replacedDeliverableId: string | null }
  | { ok: false; reason: 'stale' | 'not_candidate' | 'not_found' };

export interface IApprovalStore {
  approve(input: {
    conversationId: string;
    deliverableKind: string;
    deliverableId: string;
    expectedApprovedId: string | null;
  }): Promise<ApproveResult>;
  getApproved(
    conversationId: string,
  ): Promise<ReadonlyArray<{ deliverableKind: string; deliverableId: string; approvedAt: string }>>;
  markDependentsStale(input: {
    conversationId: string;
    deliverableKinds: ReadonlyArray<string>;
  }): Promise<void>;
}

/**
 * Optional read capability. A store that persists the stale marks written by
 * `markDependentsStale` may expose them here; the core then unions them with
 * the staleness it derives purely from approval timestamps
 * (`deriveStaleKinds`). Not part of the shared `IApprovalStore` contract.
 */
export interface IApprovalStalenessSource {
  getStaleKinds(conversationId: string): Promise<ReadonlyArray<string>>;
}

export function hasStalenessSource(
  store: IApprovalStore,
): store is IApprovalStore & IApprovalStalenessSource {
  return typeof (store as Partial<IApprovalStalenessSource>).getStaleKinds === 'function';
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
 * In-memory approval store with the same semantics the Postgres adapters
 * must provide: one approved deliverable per (conversation, kind), atomic
 * replace, append-only history, `expectedApprovedId` concurrency.
 */
export class InMemoryApprovalStore implements IApprovalStore, IApprovalStalenessSource {
  private readonly history = new Map<string, ApprovalRecord[]>();
  private readonly staleKinds = new Map<string, Set<string>>();
  private sequence = 0;

  constructor(
    private readonly candidates: ApprovalCandidateLookup,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async approve(input: {
    conversationId: string;
    deliverableKind: string;
    deliverableId: string;
    expectedApprovedId: string | null;
  }): Promise<ApproveResult> {
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

    this.sequence += 1;
    // Strictly increasing timestamps keep the timestamp-based staleness rule
    // deterministic even when two approvals land in the same millisecond.
    const base = this.now().getTime();
    const last = this.lastApprovedAt(input.conversationId);
    const approvedAt = new Date(Math.max(base, last + 1)).toISOString();
    const record: ApprovalRecord = {
      approvalId: `approval-${this.sequence}`,
      deliverableKind: input.deliverableKind,
      deliverableId: input.deliverableId,
      replacedDeliverableId: currentId,
      approvedAt,
    };
    const bucket = this.history.get(input.conversationId) ?? [];
    bucket.push(record);
    this.history.set(input.conversationId, bucket);
    // A fresh approval of this kind clears its own stale mark.
    this.staleKinds.get(input.conversationId)?.delete(input.deliverableKind);
    return { ok: true, approvalId: record.approvalId, replacedDeliverableId: currentId };
  }

  async getApproved(
    conversationId: string,
  ): Promise<ReadonlyArray<{ deliverableKind: string; deliverableId: string; approvedAt: string }>> {
    const latestByKind = new Map<string, ApprovalRecord>();
    for (const record of this.history.get(conversationId) ?? []) {
      latestByKind.set(record.deliverableKind, record);
    }
    return [...latestByKind.values()]
      .sort((a, b) => (a.deliverableKind < b.deliverableKind ? -1 : 1))
      .map(({ deliverableKind, deliverableId, approvedAt }) => ({ deliverableKind, deliverableId, approvedAt }));
  }

  async markDependentsStale(input: {
    conversationId: string;
    deliverableKinds: ReadonlyArray<string>;
  }): Promise<void> {
    // Marks may exist for kinds with nothing approved (KAN-34); the state
    // function shows «obsoleto» only as an overlay on an approved kind, and
    // a later approval of the kind clears its mark.
    const bucket = this.staleKinds.get(input.conversationId) ?? new Set<string>();
    for (const kind of input.deliverableKinds) bucket.add(kind);
    this.staleKinds.set(input.conversationId, bucket);
  }

  async getStaleKinds(conversationId: string): Promise<ReadonlyArray<string>> {
    return [...(this.staleKinds.get(conversationId) ?? [])].sort();
  }

  /** Append-only approval trail (tests and debugging). */
  historyFor(conversationId: string): ReadonlyArray<ApprovalRecord> {
    return [...(this.history.get(conversationId) ?? [])];
  }

  private currentFor(conversationId: string, kind: string): ApprovalRecord | undefined {
    const records = this.history.get(conversationId) ?? [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].deliverableKind === kind) return records[i];
    }
    return undefined;
  }

  private lastApprovedAt(conversationId: string): number {
    const records = this.history.get(conversationId) ?? [];
    return records.length ? Date.parse(records[records.length - 1].approvedAt) : 0;
  }
}
