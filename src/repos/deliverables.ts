/**
 * deliverables repository.
 *
 * Per claude/skills/database/SKILL.md:
 *   - deliverables RLS is tenant + user (admin bypasses user check). Methods
 *     here run inside `withTenantTransaction(tenant, user, ...)` so both
 *     GUCs are set before INSERT.
 *   - One row per artifact a completed task produced. The CHECK constraint
 *     requires either `content_url` or `content_inline`; we map A2AArtifact
 *     so URL-bearing artifacts populate `content_url` and text/inline ones
 *     populate `content_inline`.
 *   - `selected_at` is left NULL on insert; selection (and `superseded_by`)
 *     is a separate flow when the user picks an option from a multi-artifact
 *     task. Out of scope for this repo today.
 */
import { randomUUID } from 'node:crypto';
import type { ConversationId, TaskId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type { DeliverableInsert, DeliverableKind, DeliverableRow } from './models';

const log = loggerFor('repo.deliverables');

interface DeliverableRowDb {
  id: UUID;
  tenant_id: UUID;
  conversation_id: UUID;
  agent_task_id: UUID;
  user_id: UUID;
  kind: DeliverableKind;
  content_url: string | null;
  content_inline: Record<string, unknown> | null;
  selected_at: Date | null;
  superseded_by: UUID | null;
  created_at: Date;
}

function toDomain(row: DeliverableRowDb): DeliverableRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agentTaskId: row.agent_task_id,
    userId: row.user_id,
    kind: row.kind,
    contentUrl: row.content_url,
    contentInline: row.content_inline,
    selectedAt: row.selected_at ? row.selected_at.toISOString() : null,
    supersededBy: row.superseded_by,
    createdAt: row.created_at.toISOString(),
  };
}

export function deliverablesRepo(tenant: Tenant, user: User) {
  return {
    /**
     * Insert one deliverable for a completed agent task. Caller is expected
     * to have already persisted the agent_task row (FK target).
     */
    async insert(input: DeliverableInsert): Promise<DeliverableRow> {
      const child = log.child({
        op: 'insert',
        tenantId: tenant.id,
        userId: user.id,
        conversationId: input.conversationId,
        agentTaskId: input.agentTaskId,
        kind: input.kind,
      });
      if (input.contentUrl == null && input.contentInline == null) {
        throw new Error(
          'deliverables.insert: at least one of contentUrl or contentInline is required',
        );
      }
      const id = randomUUID();
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<DeliverableRowDb>(
          `INSERT INTO deliverables
             (id, tenant_id, conversation_id, agent_task_id, user_id,
              kind, content_url, content_inline)
           VALUES ($1, $2, $3, $4, $5,
                   $6, $7, $8::jsonb)
           RETURNING *`,
          [
            id,
            tenant.id,
            input.conversationId,
            input.agentTaskId,
            user.id,
            input.kind,
            input.contentUrl ?? null,
            input.contentInline === null || input.contentInline === undefined
              ? null
              : JSON.stringify(input.contentInline),
          ],
        );
        const row = toDomain(res.rows[0]);
        child.info({ id: row.id }, 'deliverable inserted');
        return row;
      });
    },

    async listByConversation(
      conversationId: ConversationId,
    ): Promise<DeliverableRow[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<DeliverableRowDb>(
          `SELECT * FROM deliverables
            WHERE conversation_id = $1
            ORDER BY created_at ASC`,
          [conversationId],
        );
        return res.rows.map(toDomain);
      });
    },

    async listByAgentTask(agentTaskId: TaskId): Promise<DeliverableRow[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<DeliverableRowDb>(
          `SELECT * FROM deliverables
            WHERE agent_task_id = $1
            ORDER BY created_at ASC`,
          [agentTaskId],
        );
        return res.rows.map(toDomain);
      });
    },
  };
}

export type DeliverablesRepo = ReturnType<typeof deliverablesRepo>;
