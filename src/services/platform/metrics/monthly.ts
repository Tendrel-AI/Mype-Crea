import { platformMetricsRepo, type MonthlyPlatformMetric } from '../../../repos/platform-metrics';

const repository = platformMetricsRepo();

export function currentCalendarMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getPlatformMonthlyMetrics(actorWorkosUserId: string, month = currentCalendarMonth()): Promise<MonthlyPlatformMetric[]> {
  return repository.monthly(month, actorWorkosUserId);
}

export async function getPlatformAuditTrail(actorWorkosUserId: string) {
  return repository.recentAudit(actorWorkosUserId);
}
