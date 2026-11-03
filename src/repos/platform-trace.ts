/**
 * KAN-42 platform-operator view of the trace: metadata and aggregates only (owner decision
 * 2026-11-02). Every call re-checks the persisted superadmin role and reads only the
 * `app.platform_*` functions of migration `1792800011000_conversation-trace`, which return the
 * `meta` half of each event (never message text, brief values, prompts or user ids).
 */
import type { ConversationId, UUID } from '../core/contracts';
import { withGlobalTransaction } from '../db/global-transaction';
import { assertActivePlatformActor } from './global-audit';
import { mapTraceMeta, type TraceEventDbRow, type TraceEventMeta } from './conversation-trace';

export interface PlatformConversationTrace {
  readonly tenantId: UUID;
  readonly conversationId: ConversationId;
  readonly generatedAt: string;
  readonly events: ReadonlyArray<TraceEventMeta>;
}

export type PilotMetricName =
  | 'turn_latency_ms' | 'turn_not_responded' | 'deliverable_latency_ms' | 'task_failed' | 'set_cost_usd';

export interface PilotMetricSample {
  readonly tenantId: UUID;
  readonly metric: PilotMetricName;
  /** The agent id for task metrics; null otherwise. */
  readonly subject: string | null;
  readonly startedAt: string;
  readonly value: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function platformTraceRepo() {
  return {
    /** Metadata-only timeline; an empty event list when the conversation does not exist. */
    async conversationMetadata(tenantId: string, conversationId: string, actorWorkosUserId: string): Promise<PlatformConversationTrace> {
      if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(conversationId)) throw new Error('Invalid tenant or conversation id.');
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<TraceEventDbRow>(
          `SELECT seq, occurred_at, kind, ref_id, meta FROM app.platform_conversation_trace($1, $2)`,
          [tenantId, conversationId],
        );
        return {
          tenantId: tenantId as UUID,
          conversationId: conversationId as ConversationId,
          generatedAt: new Date().toISOString(),
          events: result.rows.map(mapTraceMeta),
        };
      });
    },

    /** Up to `perTenant` random conversations per tenant started in `month` (YYYY-MM, America/Lima). */
    async sampleConversations(month: string, perTenant: number, actorWorkosUserId: string): Promise<Array<{ tenantId: UUID; conversationId: ConversationId }>> {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must use YYYY-MM format.');
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{ tenant_id: UUID; conversation_id: ConversationId }>(
          `SELECT tenant_id, conversation_id FROM app.platform_trace_sample($1::date, $2)`,
          [`${month}-01`, perTenant],
        );
        return result.rows.map((row) => ({ tenantId: row.tenant_id, conversationId: row.conversation_id }));
      });
    },

    /** Raw latency and cost samples for `[from, to)`; the report filters and aggregates them. */
    async metricSamples(from: string, to: string, actorWorkosUserId: string): Promise<PilotMetricSample[]> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{
          tenant_id: UUID; metric: PilotMetricName; subject: string | null; started_at: Date; value: string | number;
        }>(`SELECT tenant_id, metric, subject, started_at, value FROM app.platform_pilot_metric_samples($1, $2)`, [from, to]);
        return result.rows.map((row) => ({
          tenantId: row.tenant_id,
          metric: row.metric,
          subject: row.subject,
          startedAt: new Date(row.started_at).toISOString(),
          value: Number(row.value),
        }));
      });
    },
  };
}

export type PlatformTraceRepo = ReturnType<typeof platformTraceRepo>;
