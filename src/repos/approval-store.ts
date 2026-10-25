/**
 * PostgreSQL adapter for the core approval port (KAN-34 / KAN-65).
 *
 * The core declares `IApprovalStore` in `src/core/approvals.ts` (KAN-28). The repository layer
 * must not import from the core's orchestration modules, so the port types are declared here
 * structurally and must stay identical to the core's definition; TypeScript checks the match
 * wherever the core receives this object.
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

/** The subset of the approvals repository the adapter needs (injectable for unit tests). */
export type ApprovalStoreRepo = Pick<
  ReturnType<typeof approvalsRepo>,
  'approve' | 'getApproved' | 'markStale'
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

export function createApprovalStoreFromRepo(repo: ApprovalStoreRepo): IApprovalStore {
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
  };
}

export function createPostgresApprovalStore(tenant: Tenant, user: User): IApprovalStore {
  return createApprovalStoreFromRepo(approvalsRepo(tenant, user));
}
