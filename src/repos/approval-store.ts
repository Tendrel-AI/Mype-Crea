/**
 * PostgreSQL adapter for the core approval port (KAN-34 / KAN-65), wired as THE production
 * approval store at `createApprovalStore` in `src/core/orchestrator/runtime.ts`.
 *
 * The core declares `IApprovalStore` and the optional read capability `IApprovalStalenessSource`
 * in `src/core/approvals.ts` (KAN-28). The repository layer must not import from the core's
 * orchestration modules, so both are declared here structurally and must stay identical to the
 * core's definitions; TypeScript checks the match where the runtime hands this object to the core.
 *
 * Staleness (RF-07): `markDependentsStale` appends `deliverable_stale_marks` events and
 * `getStaleKinds` reads them back through `approvalsRepo.listStale` (newest mark newer than the
 * newest approval of the kind, by `event_seq`). The core feeds `getStaleKinds` into the pure
 * state function as `markedStaleKinds`; `IApprovalStore` itself is unchanged.
 */
import type { Tenant, User } from '../db/with-transaction';
import { approvalsRepo, type ApproveOutcome } from './approvals';

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

/** Optional read capability of the core (`IApprovalStalenessSource`), declared structurally. */
export interface IApprovalStalenessSource {
  getStaleKinds(conversationId: string): Promise<ReadonlyArray<string>>;
}

/** What the Postgres adapter provides: the port plus the persisted stale marks. */
export type PostgresApprovalStore = IApprovalStore & IApprovalStalenessSource;

/** The subset of the approvals repository the adapter needs (injectable for unit tests). */
export type ApprovalStoreRepo = Pick<
  ReturnType<typeof approvalsRepo>,
  'approve' | 'getApproved' | 'markStale' | 'listStale'
>;

/**
 * Map the repository outcome to the port result. An idempotent re-approval of the current
 * deliverable (`unchanged`) succeeds with the existing approval id and nothing replaced.
 */
export function toApproveResult(outcome: ApproveOutcome): ApproveResult {
  switch (outcome.kind) {
    case 'approved':
      return {
        ok: true,
        approvalId: outcome.approval.id,
        replacedDeliverableId: outcome.replacedDeliverableId,
      };
    case 'unchanged':
      return { ok: true, approvalId: outcome.approval.id, replacedDeliverableId: null };
    case 'rejected':
      return { ok: false, reason: outcome.reason };
  }
}

export function createApprovalStoreFromRepo(repo: ApprovalStoreRepo): PostgresApprovalStore {
  return {
    async approve(input) {
      return toApproveResult(await repo.approve(input));
    },
    async getApproved(conversationId) {
      const rows = await repo.getApproved(conversationId);
      return rows.map((r) => ({
        deliverableKind: r.deliverableKind,
        deliverableId: r.deliverableId,
        approvedAt: r.approvedAt,
      }));
    },
    async markDependentsStale(input) {
      await repo.markStale(input);
    },
    async getStaleKinds(conversationId) {
      return (await repo.listStale(conversationId)).map((s) => s.deliverableKind);
    },
  };
}

export function createPostgresApprovalStore(tenant: Tenant, user: User): PostgresApprovalStore {
  return createApprovalStoreFromRepo(approvalsRepo(tenant, user));
}
