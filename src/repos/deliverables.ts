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
 *     it through `approveSelected`, which is TEMPORARY: the KAN-34 approvals
 *     repository (same columns plus append-only history) replaces it.
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

export type ApproveSelectedResult =
  | { readonly ok: true; readonly selectedAt: string; readonly replacedDeliverableId: UUID | null; readonly unchanged: boolean }
  | { readonly ok: false; readonly reason: 'stale' | 'not_candidate' | 'not_found' };

export function deliverablesRepo(tenant: Tenant, user: User) {
  return {
    /**
     * TEMPORARY (until the KAN-34 approvals repository is wired): make one
     * deliverable the approved («selected») one of its kind, atomically.
     * Locks the owner-visible conversation row first, so two approvals of the
     * same conversation serialize; then:
     *   - target missing / other conversation      -> `not_found`
     *   - target of another kind                   -> `not_candidate`
     *   - current selection != expectedSelectedId  -> `stale`
     *   - target already selected                  -> ok, `unchanged`
     *   - otherwise clear the old row (`superseded_by` = target) and stamp the
     *     target, in that order (partial unique index per conversation+kind).
     */
    async approveSelected(input: {
      conversationId: ConversationId;
      kind: string;
      deliverableId: UUID;
      expectedSelectedId: UUID | null;
    }): Promise<ApproveSelectedResult> {
      const child = log.child({
        op: 'approveSelected',
        tenantId: tenant.id,
        userId: user.id,
        conversationId: input.conversationId,
        kind: input.kind,
      });
      return withTenantTransaction(tenant, user, async (tx) => {
        const conversation = await tx.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [
          input.conversationId,
        ]);
        if (conversation.rows.length === 0) return { ok: false, reason: 'not_found' } as const;
        const target = await tx.query<DeliverableRowDb>(
          `SELECT * FROM deliverables WHERE id = $1 AND conversation_id = $2`,
          [input.deliverableId, input.conversationId],
        );
        if (target.rows.length === 0) return { ok: false, reason: 'not_found' } as const;
        if (target.rows[0].kind !== input.kind) return { ok: false, reason: 'not_candidate' } as const;
        const current = await tx.query<DeliverableRowDb>(
          `SELECT * FROM deliverables
            WHERE conversation_id = $1 AND kind = $2::deliverable_kind AND selected_at IS NOT NULL`,
          [input.conversationId, input.kind],
        );
        const currentId = current.rows[0]?.id ?? null;
        if (currentId !== input.expectedSelectedId) return { ok: false, reason: 'stale' } as const;
        if (currentId === input.deliverableId) {
          return { ok: true, selectedAt: current.rows[0].selected_at!.toISOString(), replacedDeliverableId: null, unchanged: true } as const;
        }
        if (currentId) {
          await tx.query(`UPDATE deliverables SET selected_at = NULL, superseded_by = $2 WHERE id = $1`, [
            currentId,
            input.deliverableId,
          ]);
        }
        const stamped = await tx.query<{ selected_at: Date }>(
          `UPDATE deliverables SET selected_at = clock_timestamp(), superseded_by = NULL
            WHERE id = $1 RETURNING selected_at`,
          [input.deliverableId],
        );
        child.info({ deliverableId: input.deliverableId, replaced: currentId }, 'deliverable approved (selected)');
        return {
          ok: true,
          selectedAt: stamped.rows[0].selected_at.toISOString(),
          replacedDeliverableId: currentId,
          unchanged: false,
        } as const;
      });
    },

    /** TEMPORARY (see approveSelected): the currently selected deliverable per kind. */
    async listSelected(conversationId: ConversationId): Promise<DeliverableRow[]> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<DeliverableRowDb>(
          `SELECT * FROM deliverables
            WHERE conversation_id = $1 AND selected_at IS NOT NULL
            ORDER BY kind ASC`,
          [conversationId],
        );
        return res.rows.map(toDomain);
      });
    },

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
