/**
 * PostgreSQL adapter for the core approval port (KAN-34 / KAN-65), wired as THE production
 * approval store at `createApprovalStore` in `src/core/orchestrator/runtime.ts`.
 *
 * The core declares `IApprovalStore` in `src/core/approvals.ts` (KAN-28). The repository layer
 * must not import from the core's orchestration modules, so it is declared here structurally and
 * must stay identical to the core's definition; TypeScript checks the match where the runtime
 * hands this object to the core.
 *
 * Atomicity (KAN-34): `approve` passes `dependentKinds` to `approvalsRepo.approve`, which writes
 * the approval row, the selection change and the dependents' `deliverable_stale_marks` in ONE
 * `withTenantTransaction`. Staleness (RF-07) is read back by `getStaleKinds` through
 * `approvalsRepo.listStale` (newest mark newer than the newest approval of the kind, by
 * `event_seq`); it is the only source of «obsoleto».
 */
import type { Tenant, User } from '../db/with-transaction';
import { approvalsRepo, type ApproveOutcome } from './approvals';

export type ApproveResult =
  | { ok: true; approvalId: string; replacedDeliverableId: string | null }
  | { ok: false; reason: 'stale' | 'not_candidate' | 'not_found' };

export interface IApprovalStore {
  approve(input: {
    readonly conversationId: string;
    readonly deliverableKind: string;
    readonly deliverableId: string;
    readonly expectedApprovedId: string | null;
    readonly dependentKinds: ReadonlyArray<string>;
  }): Promise<ApproveResult>;
  getApproved(
    conversationId: string,
  ): Promise<ReadonlyArray<{ deliverableKind: string; deliverableId: string; approvedAt: string }>>;
  getStaleKinds(conversationId: string): Promise<ReadonlyArray<string>>;
}

/** What the Postgres adapter provides. */
export type PostgresApprovalStore = IApprovalStore;

/** The subset of the approvals repository the adapter needs (injectable for unit tests). */
export type ApprovalStoreRepo = Pick<
  ReturnType<typeof approvalsRepo>,
  'approve' | 'getApproved' | 'listStale'
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
    async getStaleKinds(conversationId) {
      return (await repo.listStale(conversationId)).map((s) => s.deliverableKind);
    },
  };
}

export function createPostgresApprovalStore(tenant: Tenant, user: User): PostgresApprovalStore {
  return createApprovalStoreFromRepo(approvalsRepo(tenant, user));
}
