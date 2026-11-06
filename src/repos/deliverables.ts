/**
 * deliverables repository.
 *
 * Per docs/agents/database.md:
 *   - deliverables RLS is tenant + user (admin bypasses user check). Methods
 *     here run inside `withTenantTransaction(tenant, user, ...)` so both
 *     GUCs are set before INSERT.
 *   - One row per artifact a completed task produced. The CHECK constraint
 *     requires either `content_url` or `content_inline`; we map A2AArtifact
 *     so URL-bearing artifacts populate `content_url` and text/inline ones
 *     populate `content_inline`.
 *   - `selected_at` is left NULL on insert. «Aprobar» (KAN-28 / KAN-65) sets
 *     it, and `superseded_by` on the replaced row, only through the KAN-34
 *     approvals repository (`approvals.ts`, which also appends the history).
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
  artifact_metadata?: Record<string, unknown> | null;
  storage_key: string | null;
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
    artifactMetadata: row.artifact_metadata ?? null,
    storageKey: row.storage_key ?? null,
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
              kind, content_url, content_inline, storage_key)
           VALUES ($1, $2, $3, $4, $5,
                   $6, $7, $8::jsonb, $9)
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
            input.storageKey ?? null,
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

    /**
     * The bucket object key of one of the caller's own deliverables (KAN-52 asset route).
     * RLS scopes the row to the tenant; the explicit `user_id` keeps it owner-only, as the
     * reload path is (a tenant-admin context does not widen it). Null when the row is unknown,
     * belongs to someone else, or has no stored object.
     */
    async findOwnStorageKey(deliverableId: UUID): Promise<string | null> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ storage_key: string }>(
          `SELECT storage_key FROM deliverables
            WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND storage_key IS NOT NULL`,
          [tenant.id, deliverableId, user.id],
        );
        return res.rows[0]?.storage_key ?? null;
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
