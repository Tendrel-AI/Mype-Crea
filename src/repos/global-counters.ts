/**
 * Platform-side aggregates (F24): per-tenant counters and the credit summary per organization.
 * Aggregates only, never brief content or per-user data. Runs in global transactions.
 */
import { withGlobalTransaction } from '../db/global-transaction';
import { assertActivePlatformActor } from './global-audit';

export interface TenantCounters {
  readonly brands: number;
  readonly products: number;
  readonly conversations: number;
  readonly turns: number;
  readonly alterations: number;
  readonly avgTurnsPerConversation: number;
  readonly avgAlterationsPerDeliverable: number;
  readonly deliverablesByKind: ReadonlyArray<{ kind: string; generated: number }>;
  readonly balanceUsd: number;
  readonly consumption30dUsd: number;
}

export interface CreditSummary { readonly balanceUsd: number; readonly consumption30dUsd: number }

const SUMMARY_SQL = `
  SELECT tenant_id, coalesce(sum(amount_usd), 0)::text AS balance,
         coalesce(-sum(amount_usd) FILTER (WHERE kind = 'consumption' AND created_at >= now() - interval '30 days'), 0)::text AS consumed
    FROM tenant_credit_entries`;

export function globalCountersRepo() {
  return {
    async forTenant(actorWorkosUserId: string, tenantId: string): Promise<TenantCounters> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const counters = await tx.query<{ c: Omit<TenantCounters, 'balanceUsd' | 'consumption30dUsd'> }>(
          'SELECT app.platform_tenant_counters($1) AS c', [tenantId]);
        const summary = await tx.query<{ balance: string; consumed: string }>(`${SUMMARY_SQL} WHERE tenant_id = $1 GROUP BY tenant_id`, [tenantId]);
        return {
          ...counters.rows[0].c,
          balanceUsd: Number(summary.rows[0]?.balance ?? 0),
          consumption30dUsd: Number(summary.rows[0]?.consumed ?? 0),
        };
      });
    },

    /** Balance and last-30-days consumption for every organization with ledger entries. */
    async creditSummaries(actorWorkosUserId: string): Promise<Map<string, CreditSummary>> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const res = await tx.query<{ tenant_id: string; balance: string; consumed: string }>(`${SUMMARY_SQL} GROUP BY tenant_id`);
        return new Map(res.rows.map((r) => [r.tenant_id, { balanceUsd: Number(r.balance), consumption30dUsd: Number(r.consumed) }]));
      });
    },
  };
}

export type GlobalCountersRepo = ReturnType<typeof globalCountersRepo>;
