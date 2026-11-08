import type { Comparison, VersionSummary } from '../src/lib/prompt-ledger';

const dash = '—';
const n = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? dash : v.toFixed(digits));
const pct = (v: number | null) => (v === null ? dash : `${(v * 100).toFixed(1)}%`);
const signed = (v: number | null, digits = 0) => (v === null ? dash : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`);

/** Plain-text comparison table of two prompt versions: aggregates only, `—` where there is no data. */
export function formatComparison(c: Comparison, versionA: string, versionB: string): string {
  const fb = (s: VersionSummary) => (s.feedback ? `${s.feedback.up} / ${s.feedback.down} (${pct(s.feedback.upRatio)})` : dash);
  const rows: string[][] = [
    ['metric', versionA, versionB, 'delta (b - a)'],
    ['runs', String(c.a.runs), String(c.b.runs), signed(c.delta.runs)],
    ['failure rate', pct(c.a.failureRate), pct(c.b.failureRate), signed(c.delta.failureRate === null ? null : c.delta.failureRate * 100, 1)],
    ['latency p50 (ms)', n(c.a.latencyMs.p50), n(c.b.latencyMs.p50), signed(c.delta.latencyMs.p50)],
    ['latency p95 (ms)', n(c.a.latencyMs.p95), n(c.b.latencyMs.p95), signed(c.delta.latencyMs.p95)],
    ['avg input tokens', n(c.a.tokens.avgInput), n(c.b.tokens.avgInput), signed(c.delta.tokens.avgInput)],
    ['avg output tokens', n(c.a.tokens.avgOutput), n(c.b.tokens.avgOutput), signed(c.delta.tokens.avgOutput)],
    ['cost total (USD)', n(c.a.costUsd.total, 4), n(c.b.costUsd.total, 4), signed(c.delta.costUsd.total, 4)],
    ['cost per run (USD)', n(c.a.costUsd.avgPerRun, 4), n(c.b.costUsd.avgPerRun, 4), signed(c.delta.costUsd.avgPerRun, 4)],
    ...[...new Set([...Object.keys(c.a.scores), ...Object.keys(c.b.scores)])].sort().map((m) => [
      `score ${m}`,
      c.a.scores[m] ? `${c.a.scores[m].mean.toFixed(3)} (n=${c.a.scores[m].n})` : dash,
      c.b.scores[m] ? `${c.b.scores[m].mean.toFixed(3)} (n=${c.b.scores[m].n})` : dash,
      signed(c.delta.scores[m] ?? null, 3),
    ]),
    ['thumbs up / down (ratio)', fb(c.a), fb(c.b), signed(c.delta.feedback.upRatio === null ? null : c.delta.feedback.upRatio * 100, 1)],
    ['samples', String(c.a.samples), String(c.b.samples), signed(c.delta.samples)],
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [`Prompt: ${c.key}`, line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n');
}

/** One line per registered version with its production-and-eval run count. */
export function formatHistory(key: string, history: Array<{ version: string; createdAt: string; summary: VersionSummary }>): string {
  if (history.length === 0) return `No versions registered for "${key}".`;
  return [`Versions of ${key}:`, ...history.map((h) => `  ${h.version}  created ${h.createdAt}  runs ${h.summary.runs}  thumbs ${h.summary.feedback ? `${h.summary.feedback.up}/${h.summary.feedback.down}` : dash}`)].join('\n');
}
