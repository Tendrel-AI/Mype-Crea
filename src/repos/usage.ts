/**
 * KAN-43 usage ledger (`usage_reservations`). Every gated provider call reserves here first.
 *
 * `reserve` takes a per-tenant transaction-scoped advisory lock, reads the committed counters,
 * asks the pure policy (`evaluateUsage`) and inserts either a `reserved` or a `denied` row, all
 * in ONE transaction. The next reserver of the tenant waits for that commit and then sees it, so
 * parallel calls cannot push spending or call counts past a cap. `preflight` runs the same check
 * without holding anything (it writes only the denied row); the reservation stays the guarantee.
 */
import type { UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import {
  PRICING_VERSION,
  USAGE_POLICY,
  evaluateUsage,
  type UsageAsk,
  type UsageCounters,
  type UsageDenialReason,
  type UsageKind,
} from '../services/usage/policy';

export interface UsageCorrelation {
  readonly provider?: string;
  readonly model?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly agentTaskId?: string;
}

export type UsageRequest = UsageAsk & UsageCorrelation;

export type UsageVerdict =
  | { readonly allowed: true; readonly reservationId: UUID | null }
  | { readonly allowed: false; readonly reason: UsageDenialReason; readonly reservationId: UUID };

export interface UsageSettlement {
  readonly reservationId: string;
  readonly actualCostUsd: number;
  readonly outcome: 'succeeded' | 'failed';
}

export interface UsageRepo {
  /** Hold the estimate (allowed) or record the denial; one locked transaction. */
  reserve(request: UsageRequest): Promise<UsageVerdict>;
  /** Check without reserving; a denial is still recorded. `reservationId` is null when allowed. */
  preflight(request: UsageRequest): Promise<UsageVerdict>;
  /** Reconcile a `reserved` row with the real cost. False when it is not the caller's reserved row. */
  settle(settlement: UsageSettlement): Promise<boolean>;
}

/** Committed counters of the tenant (and of `userId`, when given) under the current policy. */
export async function readUsageCounters(tx: TxClient, tenantId: string, userId: string | null): Promise<UsageCounters & { readonly periodStart: string }> {
  const result = await tx.query<{ committed: string; llm_hour: number; image_day: number; period_start: Date }>(
    `WITH bounds AS (
       SELECT (date_trunc('month', now() AT TIME ZONE $3::text) AT TIME ZONE $3::text) AS month_start,
              (date_trunc('day', now() AT TIME ZONE $3::text) AT TIME ZONE $3::text) AS day_start
     )
     SELECT coalesce(sum(CASE r.status WHEN 'reserved' THEN r.estimated_cost_usd
                                       WHEN 'settled' THEN r.actual_cost_usd ELSE 0 END)
                       FILTER (WHERE r.created_at >= b.month_start), 0)::text AS committed,
            count(*) FILTER (WHERE r.user_id = $2 AND r.kind = 'llm' AND r.status <> 'denied'
                               AND r.created_at > now() - interval '1 hour')::int AS llm_hour,
            count(*) FILTER (WHERE r.user_id = $2 AND r.kind = 'image' AND r.status <> 'denied'
                               AND r.created_at >= b.day_start)::int AS image_day,
            b.month_start AS period_start
       FROM bounds b
       LEFT JOIN usage_reservations r
         ON r.tenant_id = $1 AND r.created_at >= least(b.month_start, now() - interval '1 hour')
      GROUP BY b.month_start`,
    [tenantId, userId, USAGE_POLICY.timeZone],
  );
  const row = result.rows[0];
  return {
    committedUsd: Number(row.committed),
    userLlmCallsLastHour: row.llm_hour,
    userImagesToday: row.image_day,
    periodStart: new Date(row.period_start).toISOString(),
  };
}

export function usageRepo(tenant: Tenant, user: User): UsageRepo {
  async function decide(request: UsageRequest, hold: boolean): Promise<UsageVerdict> {
    return withTenantTransaction(tenant, user, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('usage_reservations:' || $1::text, 0))`, [tenant.id]);
      const counters = await readUsageCounters(tx, tenant.id, user.id);
      const reason = evaluateUsage(counters, request);
      if (!reason && !hold) return { allowed: true, reservationId: null };
      const id = await insertRow(tx, request, reason);
      return reason ? { allowed: false, reason, reservationId: id } : { allowed: true, reservationId: id };
    });
  }

  async function insertRow(tx: TxClient, request: UsageRequest, reason: UsageDenialReason | null): Promise<UUID> {
    const result = await tx.query<{ id: UUID }>(
      `INSERT INTO usage_reservations
         (tenant_id, user_id, kind, status, denial_reason, estimated_cost_usd, pricing_version,
          provider, model, conversation_id, turn_id, attempt_id, agent_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        tenant.id,
        user.id,
        request.kind satisfies UsageKind,
        reason ? 'denied' : 'reserved',
        reason,
        request.estimatedCostUsd,
        PRICING_VERSION,
        request.provider ?? null,
        request.model ?? null,
        request.conversationId ?? null,
        request.turnId ?? null,
        request.attemptId ?? null,
        request.agentTaskId ?? null,
      ],
    );
    return result.rows[0].id;
  }

  return {
    reserve: (request) => decide(request, true),
    preflight: (request) => decide(request, false),
    async settle({ reservationId, actualCostUsd, outcome }) {
      return withTenantTransaction(tenant, user, async (tx) => {
        const result = await tx.query(
          `UPDATE usage_reservations
              SET status = 'settled', actual_cost_usd = $4, outcome = $5, settled_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND status = 'reserved'`,
          [tenant.id, user.id, reservationId, actualCostUsd, outcome],
        );
        return (result.rowCount ?? 0) === 1;
      });
    },
  };
}
