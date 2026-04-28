/**
 * messages repository.
 *
 * Per claude/skills/database/SKILL.md:
 *   - messages RLS is tenant + (admin OR own user). Both GUCs must be set.
 *   - All queries inside an explicit transaction; no raw pool access.
 *   - Index (tenant_id, conversation_id, created_at DESC) supports list reads.
 */
import type { ConversationId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type {
  ListMessagesOptions,
  MessageGenerationStatus,
  MessageInsert,
  MessageRow,
} from './models';

const log = loggerFor('repo.messages');

interface MessageRowDb {
  id: UUID;
  conversation_id: UUID;
  user_id: UUID;
  role: 'user' | 'assistant' | 'system';
  content: string;
  generation_status: MessageGenerationStatus;
  completed_at: Date | null;
  created_at: Date;
}

function toDomain(row: MessageRowDb): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    content: row.content,
    generationStatus: row.generation_status,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export function messagesRepo(tenant: Tenant, user: User) {
  return {
    /**
     * Insert a message row attributed to the current user. Returns the
     * persisted row including server-assigned id and timestamps.
     */
    async insert(input: MessageInsert): Promise<MessageRow> {
      const child = log.child({
        op: 'insert',
        tenantId: tenant.id,
        userId: user.id,
        conversationId: input.conversationId,
        role: input.role,
      });
      child.debug({ contentLength: input.content.length }, 'inserting message');
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<MessageRowDb>(
          `INSERT INTO messages
             (tenant_id, conversation_id, user_id, role, content, generation_status)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, conversation_id, user_id, role, content,
                     generation_status, completed_at, created_at`,
          [
            tenant.id,
            input.conversationId,
            user.id,
            input.role,
            input.content,
            input.generationStatus ?? 'complete',
          ],
        );
        const row = toDomain(res.rows[0]);
        child.info({ id: row.id }, 'message inserted');
        return row;
      });
    },

    /**
     * List messages for a conversation (oldest first by default).
     */
    async listByConversation(
      conversationId: ConversationId,
      opts: ListMessagesOptions = {},
    ): Promise<MessageRow[]> {
      const child = log.child({
        op: 'listByConversation',
        tenantId: tenant.id,
        userId: user.id,
        conversationId,
      });
      const limit = opts.limit ?? 1000;
      const direction = opts.orderDescending ? 'DESC' : 'ASC';
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<MessageRowDb>(
          `SELECT id, conversation_id, user_id, role, content,
                  generation_status, completed_at, created_at
             FROM messages
            WHERE conversation_id = $1
            ORDER BY created_at ${direction}
            LIMIT $2`,
          [conversationId, limit],
        );
        child.debug({ rowsAffected: res.rowCount }, 'messages listed');
        return res.rows.map(toDomain);
      });
    },

    /**
     * Mark a message as complete (sets completed_at to now()).
     */
    async markComplete(messageId: UUID): Promise<void> {
      const child = log.child({
        op: 'markComplete',
        tenantId: tenant.id,
        userId: user.id,
        messageId,
      });
      await withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query(
          `UPDATE messages
              SET generation_status = 'complete',
                  completed_at      = now()
            WHERE id = $1`,
          [messageId],
        );
        child.info({ rowsAffected: res.rowCount }, 'message marked complete');
        if (res.rowCount === 0) {
          throw new Error(`No message row to mark complete: ${messageId}`);
        }
      });
    },

    /**
     * Mark a message as failed. The reason is logged structurally; we don't
     * persist it on the row (no error column on messages today).
     */
    async markFailed(messageId: UUID, reason: string): Promise<void> {
      const child = log.child({
        op: 'markFailed',
        tenantId: tenant.id,
        userId: user.id,
        messageId,
        reason,
      });
      await withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query(
          `UPDATE messages
              SET generation_status = 'failed',
                  completed_at      = now()
            WHERE id = $1`,
          [messageId],
        );
        child.warn({ rowsAffected: res.rowCount }, 'message marked failed');
        if (res.rowCount === 0) {
          throw new Error(`No message row to mark failed: ${messageId}`);
        }
      });
    },
  };
}

export type MessagesRepo = ReturnType<typeof messagesRepo>;
