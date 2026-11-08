/**
 * deliverable_feedback repository (prompt ledger step 4, F13 / D21): the owner's thumbs up/down
 * on a generated deliverable version. RLS limits rows to the current tenant and user, and to the
 * user's own deliverables. `prompt_version` is copied from the deliverable's artifact metadata in
 * the same statement, so the client can never choose it.
 */
import type { ConversationId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';

export type FeedbackValue = 'up' | 'down';

export function deliverableFeedbackRepo(tenant: Tenant, user: User) {
  return {
    /**
     * Upsert (`value`) or clear (`null`) the caller's rating. `found` is false when the
     * deliverable is not one of the caller's own in that conversation; nothing is written then.
     */
    async set(
      conversationId: ConversationId,
      deliverableId: UUID,
      value: FeedbackValue | null,
    ): Promise<{ found: boolean; value: FeedbackValue | null }> {
      return withTenantTransaction(tenant, user, async (tx) => {
        if (value === null) {
          // Ownership first: a deliverable outside this conversation must not lose its rating.
          const owned = await tx.query(
            `SELECT 1 FROM deliverables WHERE tenant_id = $1 AND id = $2 AND conversation_id = $3 AND user_id = $4`,
            [tenant.id, deliverableId, conversationId, user.id],
          );
          if (owned.rows.length === 0) return { found: false, value: null };
          await tx.query(
            `DELETE FROM deliverable_feedback WHERE tenant_id = $1 AND deliverable_id = $2 AND user_id = $3`,
            [tenant.id, deliverableId, user.id],
          );
          return { found: true, value: null };
        }
        const res = await tx.query<{ value: FeedbackValue }>(
          `INSERT INTO deliverable_feedback (tenant_id, deliverable_id, user_id, value, prompt_version)
           SELECT d.tenant_id, d.id, d.user_id, $4, d.artifact_metadata->>'promptVersion'
             FROM deliverables d
            WHERE d.tenant_id = $1 AND d.id = $2 AND d.conversation_id = $3 AND d.user_id = $5
           ON CONFLICT (tenant_id, deliverable_id, user_id)
           DO UPDATE SET value = EXCLUDED.value, prompt_version = EXCLUDED.prompt_version, updated_at = now()
           RETURNING value`,
          [tenant.id, deliverableId, conversationId, value, user.id],
        );
        return { found: res.rows.length > 0, value: res.rows[0]?.value ?? null };
      });
    },

    /** The caller's ratings of a conversation's deliverables, keyed by deliverable id. */
    async listByConversation(conversationId: ConversationId): Promise<Record<string, FeedbackValue>> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ deliverable_id: string; value: FeedbackValue }>(
          `SELECT f.deliverable_id, f.value
             FROM deliverable_feedback f
             JOIN deliverables d ON d.tenant_id = f.tenant_id AND d.id = f.deliverable_id
            WHERE f.tenant_id = $1 AND f.user_id = $2 AND d.conversation_id = $3`,
          [tenant.id, user.id, conversationId],
        );
        return Object.fromEntries(res.rows.map((r) => [r.deliverable_id, r.value]));
      });
    },
  };
}

export type DeliverableFeedbackRepo = ReturnType<typeof deliverableFeedbackRepo>;
