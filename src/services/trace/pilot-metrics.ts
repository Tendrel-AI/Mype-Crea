/**
 * KAN-42 pilot metrics report (owner decision 2026-11-02). Pure: turns the raw samples from
 * `platformTraceRepo().metricSamples` into the numbers the AC asks for. It reports values next
 * to their references and never decides compliance.
 *
 *  - Operating hours: weekdays 09:00–18:00 America/Lima (KAN-67). Latency samples and failure
 *    counts are kept only when they STARTED inside those hours. Set costs are not filtered by
 *    time of day: a set's cost does not depend on when it ran.
 *  - Percentiles use the nearest-rank method on the filtered samples.
 *  - Own availability is not computed: nothing in the database records uptime. It stays a
 *    documented gap until an external uptime monitor polls `/api/health`.
 */
import type { PilotMetricSample } from '../../repos/platform-trace';

export const OPERATING_HOURS = 'weekdays 09:00-18:00 America/Lima';
export const INTERACTION_P95_REFERENCE_MS = 4000;
/** Thesis estimate per deliverable set. A reporting reference only: NOT approved as a cap. */
export const SET_COST_REFERENCE_USD = 0.48;

const LIMA_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Lima', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
});

export function isOperatingHours(iso: string): boolean {
  const parts = LIMA_PARTS.formatToParts(new Date(iso));
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  return weekday !== 'Sat' && weekday !== 'Sun' && hour >= 9 && hour < 18;
}

/** Nearest-rank percentile; null for no samples. */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function mean(values: ReadonlyArray<number>): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function latency(values: ReadonlyArray<number>) {
  return { count: values.length, meanMs: mean(values), p50Ms: percentile(values, 50), p95Ms: percentile(values, 95) };
}

export interface PilotMetricsReport {
  readonly operatingHours: string;
  readonly load: {
    readonly turnsResponded: number;
    readonly turnsNotResponded: number;
    readonly tasksCompleted: number;
    readonly tasksFailed: number;
  };
  readonly interaction: ReturnType<typeof latency> & { readonly referenceP95Ms: number };
  readonly deliverableLatency: Readonly<Record<string, ReturnType<typeof latency>>>;
  readonly costPerSet: {
    readonly sets: number;
    readonly meanUsd: number | null;
    readonly totalUsd: number;
    readonly referenceUsd: number;
    readonly referenceStatus: 'thesis estimate, not approved as a cap';
  };
  readonly ownAvailability: { readonly measured: false; readonly gap: string };
}

export function computePilotMetrics(samples: ReadonlyArray<PilotMetricSample>): PilotMetricsReport {
  const inHours = samples.filter((sample) => sample.metric === 'set_cost_usd' || isOperatingHours(sample.startedAt));
  const values = (metric: PilotMetricSample['metric']) => inHours.filter((s) => s.metric === metric).map((s) => s.value);
  const deliverableLatency: Record<string, number[]> = {};
  for (const sample of inHours) {
    if (sample.metric !== 'deliverable_latency_ms') continue;
    (deliverableLatency[sample.subject ?? 'unknown'] ??= []).push(sample.value);
  }
  const turns = values('turn_latency_ms');
  const costs = values('set_cost_usd');
  return {
    operatingHours: OPERATING_HOURS,
    load: {
      turnsResponded: turns.length,
      turnsNotResponded: values('turn_not_responded').length,
      tasksCompleted: Object.values(deliverableLatency).reduce((sum, list) => sum + list.length, 0),
      tasksFailed: values('task_failed').length,
    },
    interaction: { ...latency(turns), referenceP95Ms: INTERACTION_P95_REFERENCE_MS },
    deliverableLatency: Object.fromEntries(Object.entries(deliverableLatency).sort().map(([agent, list]) => [agent, latency(list)])),
    costPerSet: {
      sets: costs.length,
      meanUsd: mean(costs),
      totalUsd: costs.reduce((sum, value) => sum + value, 0),
      referenceUsd: SET_COST_REFERENCE_USD,
      referenceStatus: 'thesis estimate, not approved as a cap',
    },
    ownAvailability: {
      measured: false,
      gap: 'No uptime record exists in the database. Measure it with an external monitor polling GET /api/health during operating hours, separate from third-party status (WorkOS, LLM provider, fal.ai).',
    },
  };
}
