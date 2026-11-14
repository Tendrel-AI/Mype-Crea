/**
 * KAN-42 (SYS-07) conversation trace: one ordered, read-only timeline per conversation, built
 * by `app.conversation_trace_events` (migration `1792800011000_conversation-trace`) from rows
 * the app already writes (turns, attempts, LLM calls, messages, notices, tasks, deliverables,
 * outbox, approvals, stale marks, usage reservations, write rejections, terms acceptances).
 *
 * Access (owner decision 2026-11-02): the conversation owner, or an active tenant admin of the
 * same tenant, gets every event with its content. Anyone else gets `undefined`, the same answer
 * as for a missing id. The transaction is READ ONLY. For the admin, the persisted role is
 * re-checked in the transaction before `app.is_tenant_admin` is set, because conversations,
 * messages, deliverables and approvals gate admin reads on that flag.
 */
import type { ConversationId, UUID } from '../core/contracts';
import { clientDeliverableUrl } from '../core/deliverable-url';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type { RepositoryActor } from './ai-config';

const log = loggerFor('repo.conversation-trace');

export type TraceEventKind =
  | 'conversation' | 'terms_acceptance' | 'turn' | 'message' | 'attempt' | 'llm_call' | 'notice'
  | 'write_rejection' | 'usage_reservation' | 'task' | 'task_settled' | 'deliverable'
  | 'outbox_event' | 'approval' | 'stale_mark';

/** Metadata only: ids, timestamps, statuses, models, versions, latencies, tokens, costs. */
export interface TraceEventMeta {
  readonly seq: number;
  readonly at: string;
  readonly kind: TraceEventKind;
  readonly refId: UUID | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** A full event: `content` holds text, brief values, prompts, payloads and user ids. */
export interface TraceEvent extends TraceEventMeta {
  readonly content: Readonly<Record<string, unknown>> | null;
}

export interface ConversationTimeline {
  readonly conversationId: ConversationId;
  readonly access: 'owner' | 'tenant_admin';
  readonly generatedAt: string;
  readonly events: ReadonlyArray<TraceEvent>;
}

export interface TraceEventDbRow {
  readonly seq: string | number;
  readonly occurred_at: Date | string;
  readonly kind: TraceEventKind;
  readonly ref_id: UUID | null;
  readonly meta: Record<string, unknown>;
}

export function mapTraceMeta(row: TraceEventDbRow): TraceEventMeta {
  return {
    seq: Number(row.seq),
    at: new Date(row.occurred_at).toISOString(),
    kind: row.kind,
    refId: row.ref_id,
    meta: row.meta,
  };
}

/** KAN-52: a stored image is only ever exposed as its asset route; the bucket key never leaves. */
function clientContent(kind: TraceEventKind, refId: UUID | null, content: Record<string, unknown> | null) {
  if (kind !== 'deliverable' || !content || !refId) return content;
  const { storageKey, contentUrl, ...rest } = content;
  return {
    ...rest,
    contentUrl: clientDeliverableUrl({
      id: refId,
      contentUrl: typeof contentUrl === 'string' ? contentUrl : null,
      storageKey: typeof storageKey === 'string' ? storageKey : null,
      metadata: rest.artifactMetadata ?? (rest.contentInline as { metadata?: unknown } | null | undefined)?.metadata,
    }),
  };
}

async function accessFor(
  tx: TxClient, tenant: Tenant, user: User, actor: RepositoryActor | undefined, conversationId: ConversationId,
): Promise<'owner' | 'tenant_admin' | undefined> {
  const own = await tx.query(
    `SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2 AND user_id=$3`,
    [tenant.id, conversationId, user.id],
  );
  if (own.rows.length) return 'owner';
  if (actor?.tenantRole !== 'admin') return undefined;
  const admin = await tx.query<{ ok: boolean }>(`SELECT app.has_tenant_admin() AS ok`);
  if (!admin.rows[0]?.ok) return undefined;
  await tx.query(`SELECT set_config('app.is_tenant_admin', 'true', true)`);
  return 'tenant_admin';
}

export function conversationTraceRepo(tenant: Tenant, user: User, actor?: RepositoryActor) {
  return {
    async timeline(conversationId: ConversationId): Promise<ConversationTimeline | undefined> {
      return withTenantTransaction(tenant, user, async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        const access = await accessFor(tx, tenant, user, actor, conversationId);
        if (!access) return undefined;
        const result = await tx.query<TraceEventDbRow & { content: Record<string, unknown> | null }>(
          `SELECT seq, occurred_at, kind, ref_id, meta, content FROM app.conversation_trace_events($1, $2)`,
          [tenant.id, conversationId],
        );
        // No `conversation` event means the id is not in this tenant: same answer as a foreign id.
        if (!result.rows.some((row) => row.kind === 'conversation')) return undefined;
        if (access === 'tenant_admin') {
          log.info({ tenantId: tenant.id, userId: user.id, conversationId }, 'trace.tenant_admin_read');
        }
        return {
          conversationId,
          access,
          generatedAt: new Date().toISOString(),
          events: result.rows.map((row) => ({
            ...mapTraceMeta(row),
            content: clientContent(row.kind, row.ref_id, row.content),
          })),
        };
      });
    },
  };
}

export type ConversationTraceRepo = ReturnType<typeof conversationTraceRepo>;
