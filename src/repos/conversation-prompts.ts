/**
 * Per-conversation prompt pin (D22). The first turn stores the active frozen versions in
 * `conversations.prompt_versions`; later turns read them back. Owner-only: a conversation of
 * another user or tenant is never touched, even by a tenant admin.
 */
import type { ConversationId } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { ConversationUnavailableError } from './conversations';

export type PromptVersionMap = Readonly<Record<string, string>>;

export function conversationPromptsRepo(tenant: Tenant, user: User) {
  return {
    /** Set the pin only when it is still NULL and return the stored map (the caller's `versions` or the earlier pin). */
    async pin(conversationId: ConversationId, versions: PromptVersionMap): Promise<PromptVersionMap> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const params = [tenant.id, conversationId, user.id];
        const set = await tx.query<{ prompt_versions: PromptVersionMap }>(
          `UPDATE conversations SET prompt_versions = $4::jsonb
            WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND prompt_versions IS NULL
        RETURNING prompt_versions`,
          [...params, JSON.stringify(versions)],
        );
        if (set.rows[0]) return set.rows[0].prompt_versions;
        // Already pinned (or a concurrent first turn won): read it back in a fresh snapshot.
        const read = await tx.query<{ prompt_versions: PromptVersionMap | null }>(
          `SELECT prompt_versions FROM conversations WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
          params,
        );
        const stored = read.rows[0]?.prompt_versions;
        if (!stored) throw new ConversationUnavailableError();
        return stored;
      });
    },
  };
}

export type ConversationPromptsRepo = ReturnType<typeof conversationPromptsRepo>;
