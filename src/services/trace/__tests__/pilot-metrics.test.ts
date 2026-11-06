import { describe, expect, it } from 'vitest';
import type { PilotMetricSample } from '../../../repos/platform-trace';
import { computePilotMetrics, isOperatingHours, percentile, SET_COST_REFERENCE_USD } from '../pilot-metrics';

const TENANT = '11111111-1111-4111-8111-111111111111';
// 2026-11-02 is a Monday. Lima is UTC-5 all year.
const MONDAY_10_LIMA = '2026-11-02T15:00:00.000Z';
const sample = (metric: PilotMetricSample['metric'], value: number, startedAt = MONDAY_10_LIMA, subject: string | null = null): PilotMetricSample => ({
  tenantId: TENANT as PilotMetricSample['tenantId'], metric, subject, startedAt, value,
});

describe('KAN-42 pilot metrics', () => {
  it.each([
    ['2026-11-02T14:00:00.000Z', true], // Mon 09:00 Lima, first minute in
    ['2026-11-02T13:59:59.000Z', false], // Mon 08:59:59
    ['2026-11-02T22:59:59.000Z', true], // Mon 17:59:59
    ['2026-11-02T23:00:00.000Z', false], // Mon 18:00, out
    ['2026-11-07T15:00:00.000Z', false], // Sat 10:00
    ['2026-11-08T15:00:00.000Z', false], // Sun 10:00
    ['2026-11-07T03:00:00.000Z', false], // Fri 22:00 Lima, Sat in UTC
  ])('operating hours %s → %s', (iso, expected) => {
    expect(isOperatingHours(iso)).toBe(expected);
  });

  it('uses the nearest-rank percentile', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('aggregates in-hours latencies, failures and set costs, and never claims compliance', () => {
    const report = computePilotMetrics([
      sample('turn_latency_ms', 1000),
      sample('turn_latency_ms', 3000),
      sample('turn_latency_ms', 90_000, '2026-11-07T15:00:00.000Z'), // Saturday: excluded
      sample('turn_not_responded', 1),
      sample('deliverable_latency_ms', 20_000, MONDAY_10_LIMA, 'logo-agent'),
      sample('deliverable_latency_ms', 40_000, MONDAY_10_LIMA, 'logo-agent'),
      sample('deliverable_latency_ms', 5_000, MONDAY_10_LIMA, 'name-agent'),
      sample('task_failed', 1, MONDAY_10_LIMA, 'logo-agent'),
      sample('set_cost_usd', 0.2),
      sample('set_cost_usd', 0.4, '2026-11-08T15:00:00.000Z'), // costs are not hour-filtered
    ]);
    expect(report.load).toEqual({ turnsResponded: 2, turnsNotResponded: 1, tasksCompleted: 3, tasksFailed: 1 });
    expect(report.interaction).toMatchObject({ count: 2, meanMs: 2000, p95Ms: 3000, referenceP95Ms: 4000 });
    expect(report.deliverableLatency['logo-agent']).toEqual({ count: 2, meanMs: 30_000, p50Ms: 20_000, p95Ms: 40_000 });
    expect(report.deliverableLatency['name-agent']).toMatchObject({ count: 1, p95Ms: 5_000 });
    expect(report.costPerSet.sets).toBe(2);
    expect(report.costPerSet.meanUsd).toBeCloseTo(0.3);
    expect(report.costPerSet).toMatchObject({ referenceUsd: SET_COST_REFERENCE_USD, referenceStatus: 'thesis estimate, not approved as a cap' });
    expect(report.ownAvailability.measured).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/complian|pass(ed)?"|meets/i);
  });

  it('reports nulls, not zeros, when nothing was measured', () => {
    const report = computePilotMetrics([]);
    expect(report.interaction).toMatchObject({ count: 0, p95Ms: null, meanMs: null });
    expect(report.costPerSet).toMatchObject({ sets: 0, meanUsd: null });
  });
});
