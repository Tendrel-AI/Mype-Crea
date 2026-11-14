import { withGlobalTransaction } from '../db/global-transaction';
import { assertActivePlatformActor } from './global-audit';

export interface MonthlyPlatformMetric {
  readonly month: string;
  readonly organizationId: string | null;
  readonly activeUsers: number;
  readonly newConversations: number;
  readonly organizationName: string | null;
  readonly providerModelUsage: readonly { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; errors: number; estimatedCost: number; costs: readonly { currency: string | null; source: string | null; amount: number }[] }[];
  readonly estimatedCost: number;
  readonly errors: number;
  readonly activeVersions: readonly { moduleId: string; version: number; organizations?: number; sharedReleaseId?: string; releaseId?: string; name?: string }[];
}

/** Returns calendar-month aggregates only; the database function deliberately has no user/content columns. */
export function platformMetricsRepo() {
  return {
    async monthly(month: string, actorWorkosUserId: string): Promise<MonthlyPlatformMetric[]> {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must use YYYY-MM format.');
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{
          period_start: Date | string; organization_id: string | null; organization_name: string | null; active_users: string | number;
          new_conversations: string | number; provider_model_usage: MonthlyPlatformMetric['providerModelUsage'];
          estimated_cost: string | number; errors: string | number;
          active_versions: MonthlyPlatformMetric['activeVersions'];
        }>('SELECT * FROM app.platform_monthly_metrics($1::date)', [`${month}-01`]);
        return result.rows.map((row) => ({
          month: typeof row.period_start === 'string' ? row.period_start.slice(0, 7) : row.period_start.toISOString().slice(0, 7),
          organizationId: row.organization_id,
          organizationName: row.organization_name,
          activeUsers: Number(row.active_users),
          newConversations: Number(row.new_conversations),
          providerModelUsage: row.provider_model_usage ?? [],
          estimatedCost: Number(row.estimated_cost),
          errors: Number(row.errors),
          activeVersions: row.active_versions ?? [],
        }));
      });
    },

    async recentAudit(actorWorkosUserId: string, limit = 50) {
      const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{
          id: string; actor_workos_user_id: string | null; action: string; scope_type: string;
          scope_id: string | null; prior_version: string | null; new_version: string | null;
          outcome: 'success' | 'failure'; reason: string | null; created_at: Date;
        }>(`SELECT id, actor_workos_user_id, action, scope_type, scope_id, prior_version,
                   new_version, outcome, reason, created_at
            FROM platform_audit_events ORDER BY created_at DESC LIMIT $1`, [safeLimit]);
        return result.rows.map((row) => ({
          id: row.id, actorWorkosUserId: row.actor_workos_user_id, action: row.action,
          scopeType: row.scope_type, scopeId: row.scope_id, priorVersion: row.prior_version,
          newVersion: row.new_version, outcome: row.outcome, reason: row.reason,
          createdAt: row.created_at.toISOString(),
        }));
      });
    },
  };
}

export type PlatformMetricsRepo = ReturnType<typeof platformMetricsRepo>;
