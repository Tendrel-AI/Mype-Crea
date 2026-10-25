/**
 * TEMPORARY approval adapter (KAN-28) — replace with the KAN-34 store
 * ====================================================================
 *
 * `IApprovalStore` over `deliverables.selected_at` / `superseded_by` through
 * the existing tenant + owner scoped deliverables repository. It exists only
 * because this branch predates the KAN-34 persistence work. It has:
 *   - no append-only approval history (`approvalId` is synthetic),
 *   - no persisted stale marks: `markDependentsStale` is a no-op and the core
 *     derives «obsoleto» purely from approval timestamps (`deriveStaleKinds`),
 *     which gives the same answer as KAN-34's mark/clear events.
 *
 * Swap point: `createApprovalStore` in ./runtime.ts is the ONLY place this
 * class is constructed. Replace that one line with
 * `createPostgresApprovalStore({ id: tenantId }, { id: userId })` from
 * `src/repos/approval-store.ts` and delete this file.
 */

import type { ConversationId, UUID } from '../contracts';
import type { ApproveResult, IApprovalStore } from '../approvals';
import { repos, type Tenant, type User } from '../../repos';

export class SelectedAtApprovalStore implements IApprovalStore {
  private readonly tenant: Tenant;
  private readonly user: User;

  constructor(tenantId: UUID, userId: UUID) {
    this.tenant = { id: tenantId };
    this.user = { id: userId };
  }

  async approve(input: {
    conversationId: string;
    deliverableKind: string;
    deliverableId: string;
    expectedApprovedId: string | null;
  }): Promise<ApproveResult> {
    const result = await repos(this.tenant, this.user).deliverables.approveSelected({
      conversationId: input.conversationId as ConversationId,
      kind: input.deliverableKind,
      deliverableId: input.deliverableId as UUID,
      expectedSelectedId: input.expectedApprovedId as UUID | null,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      approvalId: `selected:${input.deliverableId}:${result.selectedAt}`,
      replacedDeliverableId: result.replacedDeliverableId,
    };
  }

  async getApproved(
    conversationId: string,
  ): Promise<ReadonlyArray<{ deliverableKind: string; deliverableId: string; approvedAt: string }>> {
    const rows = await repos(this.tenant, this.user).deliverables.listSelected(conversationId as ConversationId);
    return rows.map((row) => ({
      deliverableKind: row.kind,
      deliverableId: row.id,
      approvedAt: row.selectedAt!,
    }));
  }

  async markDependentsStale(): Promise<void> {
    // No persisted marks in this temporary adapter; see the file header.
  }
}
