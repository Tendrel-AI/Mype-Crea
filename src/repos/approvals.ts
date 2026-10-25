/**
 * deliverable approvals repository (KAN-34 / RF-06, decision KAN-65 A + R2).
 *
 * «Aprobar» is one explicit act per deliverable kind that both selects and approves:
 *   - the current approval is `deliverables.selected_at IS NOT NULL` (partial unique index
 *     `deliverables_selected_per_kind`, one per conversation and kind);
 *   - replacing it clears the old row's `selected_at`, points its `superseded_by` at the new
 *     deliverable ("replaced as approved by"), stamps the new row, and appends a
 *     `deliverable_approvals` history row, all in one transaction;
 *   - staleness (RF-07 / KAN-35) is an append-only `deliverable_stale_marks` event; a kind is
 *     stale while its newest mark is newer (`event_seq`) than its newest approval. Nothing is
 *     regenerated here.
 *
 * Concurrency (KAN-34 AC3): every write path locks the owner-visible conversation row
 * (`SELECT … FOR UPDATE`, the same lock the snapshot mutations use) before reading the current
 * approval, so two approvals of the same conversation serialize; the loser re-reads the
 * committed approval under READ COMMITTED and is rejected as `stale` because its
 * `expectedApprovedId` no longer matches.
 *
 * RLS: conversations, deliverables and both event tables are tenant + owner scoped, so an
 * ordinary member can only approve inside their own conversations. All access goes through
 * `withTenantTransaction(tenant, user)`.
 */
import type { ConversationId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type { DeliverableKind } from './models';

const log = loggerFor('repo.approvals');

export const DELIVERABLE_KINDS: readonly DeliverableKind[] = Object.freeze([
  'logo',
  'business_name',
  'tagline',
  'label',
  'social_pack',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

export interface ApproveInput {
  readonly conversationId: string;
  readonly deliverableKind: string;
  readonly deliverableId: string;
  /** The approved deliverable the user saw (null when none was approved). */
  readonly expectedApprovedId: string | null;
}

export type ApproveRejection = 'stale' | 'not_candidate' | 'not_found';

export interface DeliverableApprovalRow {
  readonly id: UUID;
  readonly conversationId: ConversationId;
  readonly userId: UUID;
  readonly deliverableKind: DeliverableKind;
  readonly deliverableId: UUID;
  readonly replacedDeliverableId: UUID | null;
  readonly approvedBy: UUID;
  readonly approvedAt: string;
  /** Server-assigned order shared with stale marks (strictly increasing per commit order). */
  readonly eventSeq: number;
}

export type ApproveOutcome =
  | {
      readonly kind: 'approved';
      readonly approval: DeliverableApprovalRow;
      readonly replacedDeliverableId: UUID | null;
    }
  /** The deliverable was already the approved one and `expectedApprovedId` matched: no-op. */
  | { readonly kind: 'unchanged'; readonly approval: DeliverableApprovalRow }
  | { readonly kind: 'rejected'; readonly reason: ApproveRejection };

export interface ApprovedDeliverable {
  readonly deliverableKind: DeliverableKind;
  readonly deliverableId: UUID;
  readonly approvedAt: string;
}

export interface StaleMarkRow {
  readonly id: UUID;
  readonly conversationId: ConversationId;
  readonly deliverableKind: DeliverableKind;
  readonly markedBy: UUID;
  readonly markedAt: string;
  readonly eventSeq: number;
}

export interface StaleKind {
  readonly deliverableKind: DeliverableKind;
  /** Newest mark that is not yet cleared by a later approval. */
  readonly markedAt: string;
}

interface ApprovalRowDb {
  id: UUID;
  conversation_id: UUID;
  user_id: UUID;
  deliverable_kind: DeliverableKind;
  deliverable_id: UUID;
  replaced_deliverable_id: UUID | null;
  approved_by: UUID;
  approved_at: Date;
  event_seq: string;
}

interface StaleMarkRowDb {
  id: UUID;
  conversation_id: UUID;
  deliverable_kind: DeliverableKind;
  marked_by: UUID;
  marked_at: Date;
  event_seq: string;
}

function approvalToDomain(row: ApprovalRowDb): DeliverableApprovalRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    deliverableKind: row.deliverable_kind,
    deliverableId: row.deliverable_id,
    replacedDeliverableId: row.replaced_deliverable_id,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at.toISOString(),
    eventSeq: Number(row.event_seq),
  };
}

function staleMarkToDomain(row: StaleMarkRowDb): StaleMarkRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    deliverableKind: row.deliverable_kind,
    markedBy: row.marked_by,
    markedAt: row.marked_at.toISOString(),
    eventSeq: Number(row.event_seq),
  };
}

const APPROVAL_COLUMNS = `id, conversation_id, user_id, deliverable_kind, deliverable_id,
  replaced_deliverable_id, approved_by, approved_at, event_seq`;

/**
 * Lock the conversation row visible to the current owner. Returns its owner id, or null when
 * the conversation does not exist, belongs to another tenant, or to another user.
 */
async function lockOwnConversation(
  tx: TxClient,
  tenant: Tenant,
  conversationId: string,
): Promise<UUID | null> {
  const res = await tx.query<{ user_id: UUID }>(
    `SELECT user_id FROM conversations
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [tenant.id, conversationId],
  );
  return res.rows[0]?.user_id ?? null;
}

function rejected(reason: ApproveRejection): ApproveOutcome {
  return { kind: 'rejected', reason };
}

function isSelectedIndexViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'deliverables_selected_per_kind';
}

export function approvalsRepo(tenant: Tenant, user: User) {
  return {
    /**
     * Approve `deliverableId` as the single approved deliverable of its kind, atomically.
     * Rejections: `not_found` (conversation or deliverable not visible to this owner),
     * `stale` (`expectedApprovedId` is not the current approval), `not_candidate` (the
     * deliverable belongs to another conversation or kind, or its task is not completed).
     */
    async approve(input: ApproveInput): Promise<ApproveOutcome> {
      const child = log.child({
        op: 'approve',
        tenantId: tenant.id,
        userId: user.id,
        conversationId: input.conversationId,
        deliverableKind: input.deliverableKind,
        deliverableId: input.deliverableId,
      });
      if (!isUuid(input.conversationId) || !isUuid(input.deliverableId)) {
        return { kind: 'rejected', reason: 'not_found' };
      }
      const deliverableId = input.deliverableId.toLowerCase();
      const expected =
        input.expectedApprovedId == null ? null : String(input.expectedApprovedId).toLowerCase();

      try {
        const outcome = await withTenantTransaction(tenant, user, async (tx): Promise<ApproveOutcome> => {
          const ownerId = await lockOwnConversation(tx, tenant, input.conversationId);
          // Every rejection happens before any write, so returning (and committing) is safe.
          if (ownerId === null) return rejected('not_found');
          if (!isDeliverableKind(input.deliverableKind)) return rejected('not_candidate');
          const kind = input.deliverableKind;

          const current = await tx.query<{ id: UUID }>(
            `SELECT id FROM deliverables
              WHERE tenant_id = $1 AND conversation_id = $2 AND kind = $3
                AND selected_at IS NOT NULL
              FOR UPDATE`,
            [tenant.id, input.conversationId, kind],
          );
          const currentId = current.rows[0]?.id ?? null;
          if (expected !== currentId) return rejected('stale');

          const candidate = await tx.query<{
            conversation_id: UUID;
            kind: DeliverableKind;
            task_status: string;
          }>(
            `SELECT d.conversation_id, d.kind, t.status AS task_status
               FROM deliverables d
               JOIN agent_tasks t ON t.tenant_id = d.tenant_id AND t.id = d.agent_task_id
              WHERE d.tenant_id = $1 AND d.id = $2
              FOR UPDATE OF d`,
            [tenant.id, deliverableId],
          );
          const row = candidate.rows[0];
          if (!row) return rejected('not_found');
          if (
            row.conversation_id !== input.conversationId.toLowerCase() ||
            row.kind !== kind ||
            row.task_status !== 'completed'
          ) {
            return rejected('not_candidate');
          }

          if (currentId === deliverableId) {
            const latest = await tx.query<ApprovalRowDb>(
              `SELECT ${APPROVAL_COLUMNS} FROM deliverable_approvals
                WHERE tenant_id = $1 AND conversation_id = $2 AND deliverable_kind = $3
                ORDER BY event_seq DESC LIMIT 1`,
              [tenant.id, input.conversationId, kind],
            );
            if (latest.rows[0]?.deliverable_id === deliverableId) {
              return { kind: 'unchanged', approval: approvalToDomain(latest.rows[0]) };
            }
            // A selection without a matching trail row predates KAN-34: record it once.
          } else if (currentId !== null) {
            await tx.query(
              `UPDATE deliverables SET selected_at = NULL, superseded_by = $3
                WHERE tenant_id = $1 AND id = $2`,
              [tenant.id, currentId, deliverableId],
            );
          }
          await tx.query(
            `UPDATE deliverables SET selected_at = now(), superseded_by = NULL
              WHERE tenant_id = $1 AND id = $2`,
            [tenant.id, deliverableId],
          );
          const replaced = currentId === deliverableId ? null : currentId;
          const inserted = await tx.query<ApprovalRowDb>(
            `INSERT INTO deliverable_approvals
               (tenant_id, conversation_id, user_id, deliverable_kind, deliverable_id,
                replaced_deliverable_id, approved_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING ${APPROVAL_COLUMNS}`,
            [tenant.id, input.conversationId, ownerId, kind, deliverableId, replaced, user.id],
          );
          return {
            kind: 'approved',
            approval: approvalToDomain(inserted.rows[0]),
            replacedDeliverableId: replaced,
          };
        });
        if (outcome.kind === 'approved') {
          child.info(
            { approvalId: outcome.approval.id, replacedDeliverableId: outcome.replacedDeliverableId },
            'deliverable approved',
          );
        } else if (outcome.kind === 'unchanged') {
          child.info({ approvalId: outcome.approval.id }, 'deliverable already approved');
        } else {
          child.info({ reason: outcome.reason }, 'approval rejected');
        }
        return outcome;
      } catch (err) {
        // A selected row this owner cannot see (it should not exist) still holds the index.
        if (isSelectedIndexViolation(err)) {
          child.warn('approval rejected by the one-approved-per-kind index');
          return { kind: 'rejected', reason: 'stale' };
        }
        throw err;
      }
    },

    /** Current approved deliverable per kind (from `deliverables.selected_at`). */
    async getApproved(conversationId: string): Promise<ApprovedDeliverable[]> {
      if (!isUuid(conversationId)) return [];
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ kind: DeliverableKind; id: UUID; selected_at: Date }>(
          `SELECT kind, id, selected_at FROM deliverables
            WHERE tenant_id = $1 AND conversation_id = $2 AND selected_at IS NOT NULL
            ORDER BY kind`,
          [tenant.id, conversationId],
        );
        return res.rows.map((r) => ({
          deliverableKind: r.kind,
          deliverableId: r.id,
          approvedAt: r.selected_at.toISOString(),
        }));
      });
    },

    /** Full approval/replacement trail, oldest first (optionally for one kind). */
    async listHistory(
      conversationId: string,
      deliverableKind?: DeliverableKind,
    ): Promise<DeliverableApprovalRow[]> {
      if (!isUuid(conversationId)) return [];
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<ApprovalRowDb>(
          `SELECT ${APPROVAL_COLUMNS} FROM deliverable_approvals
            WHERE tenant_id = $1 AND conversation_id = $2
              AND ($3::deliverable_kind IS NULL OR deliverable_kind = $3::deliverable_kind)
            ORDER BY event_seq ASC`,
          [tenant.id, conversationId, deliverableKind ?? null],
        );
        return res.rows.map(approvalToDomain);
      });
    },

    /**
     * Append a stale mark for each kind (RF-07). Never regenerates anything. Throws when a kind
     * is unknown or the conversation is not visible to this owner.
     */
    async markStale(input: {
      readonly conversationId: string;
      readonly deliverableKinds: ReadonlyArray<string>;
    }): Promise<StaleMarkRow[]> {
      const kinds = [...new Set(input.deliverableKinds)];
      const unknown = kinds.filter((k) => !isDeliverableKind(k));
      if (unknown.length > 0) {
        throw new Error(`approvals.markStale: unknown deliverable kinds: ${unknown.join(', ')}`);
      }
      if (kinds.length === 0) return [];
      if (!isUuid(input.conversationId)) {
        throw new Error('approvals.markStale: conversation not found');
      }
      return withTenantTransaction(tenant, user, async (tx) => {
        const ownerId = await lockOwnConversation(tx, tenant, input.conversationId);
        if (ownerId === null) throw new Error('approvals.markStale: conversation not found');
        const res = await tx.query<StaleMarkRowDb>(
          `INSERT INTO deliverable_stale_marks
             (tenant_id, conversation_id, user_id, deliverable_kind, marked_by)
           SELECT $1, $2, $3, k, $4
             FROM unnest($5::deliverable_kind[]) WITH ORDINALITY AS kinds(k, ord)
            ORDER BY ord
           RETURNING id, conversation_id, deliverable_kind, marked_by, marked_at, event_seq`,
          [tenant.id, input.conversationId, ownerId, user.id, kinds],
        );
        log.info(
          { op: 'markStale', tenantId: tenant.id, conversationId: input.conversationId, kinds },
          'deliverable kinds marked stale',
        );
        return res.rows.map(staleMarkToDomain);
      });
    },

    /** Kinds whose newest stale mark is newer than their newest approval. */
    async listStale(conversationId: string): Promise<StaleKind[]> {
      if (!isUuid(conversationId)) return [];
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ deliverable_kind: DeliverableKind; marked_at: Date }>(
          `SELECT m.deliverable_kind, max(m.marked_at) AS marked_at
             FROM deliverable_stale_marks m
            WHERE m.tenant_id = $1 AND m.conversation_id = $2
            GROUP BY m.deliverable_kind
           HAVING max(m.event_seq) > coalesce((
                    SELECT max(a.event_seq) FROM deliverable_approvals a
                     WHERE a.tenant_id = $1 AND a.conversation_id = $2
                       AND a.deliverable_kind = m.deliverable_kind), 0)
            ORDER BY m.deliverable_kind`,
          [tenant.id, conversationId],
        );
        return res.rows.map((r) => ({
          deliverableKind: r.deliverable_kind,
          markedAt: r.marked_at.toISOString(),
        }));
      });
    },
  };
}

export type ApprovalsRepo = ReturnType<typeof approvalsRepo>;
