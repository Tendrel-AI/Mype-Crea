import { platformMetricsRepo, type MonthlyPlatformMetric } from '../../../repos/platform-metrics';

const repository = platformMetricsRepo();

/**
 * KAN-71 small-cohort rule (pipeline/decisions/KAN-71-small-cohort-suppression.md): a row whose
 * month has fewer active users than this exposes no counts or costs. Applies to every
 * organization row and to the platform-wide row (organizationId null).
 */
export const MIN_COHORT_ACTIVE_USERS = 5;

type CountField = 'activeUsers' | 'newConversations' | 'providerModelUsage' | 'estimatedCost' | 'errors';

export type PlatformMonthlyMetricRow =
  | (MonthlyPlatformMetric & { readonly suppressed: false })
  | (Omit<MonthlyPlatformMetric, CountField> & { readonly suppressed: true } & { readonly [K in CountField]: null });

/** Active versions stay: they are configuration, not activity of the cohort. */
export function suppressSmallCohort(row: MonthlyPlatformMetric): PlatformMonthlyMetricRow {
  if (row.activeUsers >= MIN_COHORT_ACTIVE_USERS) return { ...row, suppressed: false };
  return {
    month: row.month, organizationId: row.organizationId, organizationName: row.organizationName,
    activeVersions: row.activeVersions, suppressed: true,
    activeUsers: null, newConversations: null, providerModelUsage: null, estimatedCost: null, errors: null,
  };
}

export function currentCalendarMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getPlatformMonthlyMetrics(actorWorkosUserId: string, month = currentCalendarMonth()): Promise<PlatformMonthlyMetricRow[]> {
  return (await repository.monthly(month, actorWorkosUserId)).map(suppressSmallCohort);
}

export async function getPlatformAuditTrail(actorWorkosUserId: string) {
  return repository.recentAudit(actorWorkosUserId);
}
