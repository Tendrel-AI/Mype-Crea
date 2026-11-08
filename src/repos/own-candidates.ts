/**
 * KAN-89 (F12): a version the user brings instead of generating it («Usar mi nombre / logo / lema»).
 *
 * It is stored like any generated version so the rest of the workflow (approve, history, upstream
 * inputs, PDF, reload) needs no special case: one `completed` task (marker `origin: 'user'`, no
 * handler, no cost) and one deliverable whose artifact metadata says `origin: 'user'`. Approving it is
 * a normal approval (`approvals.approve`), done by the caller. Owner only (RLS + explicit predicates).
 */
import { randomUUID } from 'node:crypto';
import type { ConversationId, UUID } from '../core/contracts';
import { USER_ORIGIN } from '../core/deliverable-inputs';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type { BrandFileRow } from './brand-files';

const log = loggerFor('repo.own-candidates');

export interface OwnCandidateInput {
  /** Chosen by the caller: the bucket key of a copied logo embeds it. */
  readonly deliverableId: UUID;
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly agentCardVersion: string;
  readonly deliverableKind: string;
  /** The text itself, or the uploaded file it came from. */
  readonly source: { readonly text: string } | { readonly file: Pick<BrandFileRow, 'originalName'>; readonly storageKey: string };
}

export function ownCandidatesRepo(tenant: Tenant, user: User) {
  return {
    /** The brand logo upload of the conversation's brand, or null (no brand, no upload, foreign conversation). */
    async findBrandLogo(conversationId: ConversationId): Promise<Pick<BrandFileRow, 'storageKey' | 'contentType' | 'originalName'> | null> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ storage_key: string; content_type: string; original_name: string }>(
          `SELECT f.storage_key, f.content_type, f.original_name
             FROM conversations c
             JOIN brand_files f ON f.tenant_id = c.tenant_id AND f.brand_id = c.brand_id AND f.kind = 'logo'
            WHERE c.tenant_id = $1 AND c.id = $2 AND c.user_id = $3 AND f.user_id = $3`,
          [tenant.id, conversationId, user.id],
        );
        const row = res.rows[0];
        return row ? { storageKey: row.storage_key, contentType: row.content_type, originalName: row.original_name } : null;
      });
    },

    /** The brand's oldest brand-chat (no product) conversation, where an imported brand's identity is stored. */
    async findBrandConversation(brandId: UUID): Promise<ConversationId | null> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const res = await tx.query<{ id: ConversationId }>(
          `SELECT id FROM conversations
            WHERE tenant_id = $1 AND user_id = $2 AND brand_id = $3 AND product_id IS NULL
            ORDER BY started_at, id LIMIT 1`,
          [tenant.id, user.id, brandId],
        );
        return res.rows[0]?.id ?? null;
      });
    },

    /**
     * Insert the task and the deliverable in one transaction. False when the conversation is not the
     * caller's, or belongs to a product (brand-level kinds are never made in a product chat).
     */
    async insert(input: OwnCandidateInput): Promise<boolean> {
      return withTenantTransaction(tenant, user, async (tx) => {
        const owned = await tx.query(
          `SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND product_id IS NULL FOR UPDATE`,
          [tenant.id, input.conversationId, user.id],
        );
        if (owned.rows.length === 0) return false;
        const taskId = randomUUID();
        await tx.query(
          `INSERT INTO agent_tasks
             (id, tenant_id, conversation_id, agent_id, agent_card_version, status, idempotency_key,
              iteration_root_id, iteration_number, requirements_snapshot, completed_at)
           VALUES ($1, $2, $3, $4, $5, 'completed', $6, $1, 1, $7::jsonb, now())`,
          [taskId, tenant.id, input.conversationId, input.agentId, input.agentCardVersion, randomUUID(),
            JSON.stringify({ origin: USER_ORIGIN })],
        );
        const isFile = 'file' in input.source;
        const metadata = { origin: USER_ORIGIN, ...(isFile ? { originalName: input.source.file.originalName } : {}) };
        const kind = isFile ? 'image' : 'text';
        const value = isFile ? input.source.file.originalName : input.source.text;
        await tx.query(
          `INSERT INTO deliverables
             (id, tenant_id, conversation_id, agent_task_id, user_id, kind, content_inline,
              artifact_kind, artifact_metadata, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)`,
          [input.deliverableId, tenant.id, input.conversationId, taskId, user.id, input.deliverableKind,
            JSON.stringify({ value, kind, metadata }), kind, JSON.stringify(metadata), isFile ? input.source.storageKey : null],
        );
        log.debug({ conversationId: input.conversationId, kind: input.deliverableKind, deliverableId: input.deliverableId }, 'own_candidate.inserted');
        return true;
      });
    },
  };
}

export type OwnCandidatesRepo = ReturnType<typeof ownCandidatesRepo>;
