import type { Comparison, Feedback, Run, Score, SummaryDelta, VersionSummary } from './types';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
const present = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined);

// Nearest-rank percentile; input need not be sorted.
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// shortcut: aggregation runs in memory over all runs of a version; move it into the store (SQL) when a version has more than ~10k runs.
export function summarizeVersion(
  runs: Run[],
  scores: Score[],
  sampleCount: number,
  feedback: Feedback[] | null,
): VersionSummary {
  const latencies = present(runs.map((r) => r.latencyMs));
  const costs = present(runs.map((r) => r.costUsd));
  const known = runs.filter((r) => r.outcome !== undefined);

  const byMetric = new Map<string, number[]>();
  for (const s of scores) byMetric.set(s.metric, [...(byMetric.get(s.metric) ?? []), s.value]);
  const scoreSummary: VersionSummary['scores'] = {};
  for (const [metric, vals] of byMetric) scoreSummary[metric] = { mean: sum(vals) / vals.length, n: vals.length };

  const up = feedback?.filter((f) => f.value === 'up').length ?? 0;
  const down = (feedback?.length ?? 0) - up;

  return {
    runs: runs.length,
    failureRate: known.length ? known.filter((r) => r.outcome === 'failed').length / known.length : null,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    tokens: {
      avgInput: mean(present(runs.map((r) => r.inputTokens))),
      avgOutput: mean(present(runs.map((r) => r.outputTokens))),
    },
    costUsd: { total: costs.length ? sum(costs) : null, avgPerRun: mean(costs) },
    scores: scoreSummary,
    feedback: feedback ? { up, down, upRatio: feedback.length ? up / feedback.length : null } : null,
    samples: sampleCount,
  };
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);

export function diffSummaries(a: VersionSummary, b: VersionSummary): SummaryDelta {
  const metrics = new Set([...Object.keys(a.scores), ...Object.keys(b.scores)]);
  return {
    runs: b.runs - a.runs,
    failureRate: diff(a.failureRate, b.failureRate),
    latencyMs: { p50: diff(a.latencyMs.p50, b.latencyMs.p50), p95: diff(a.latencyMs.p95, b.latencyMs.p95) },
    tokens: {
      avgInput: diff(a.tokens.avgInput, b.tokens.avgInput),
      avgOutput: diff(a.tokens.avgOutput, b.tokens.avgOutput),
    },
    costUsd: { total: diff(a.costUsd.total, b.costUsd.total), avgPerRun: diff(a.costUsd.avgPerRun, b.costUsd.avgPerRun) },
    scores: Object.fromEntries(
      [...metrics].map((m) => [m, diff(a.scores[m]?.mean ?? null, b.scores[m]?.mean ?? null)]),
    ),
    feedback: { upRatio: diff(a.feedback?.upRatio ?? null, b.feedback?.upRatio ?? null) },
    samples: b.samples - a.samples,
  };
}

export function buildComparison(key: string, a: VersionSummary, b: VersionSummary): Comparison {
  return { key, a, b, delta: diffSummaries(a, b) };
}
