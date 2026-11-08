import { describe, expect, it } from 'vitest';
import { summarizeVersion } from '../../src/lib/prompt-ledger';
import { formatComparison, formatHistory } from '../prompt-ledger-report-format';

const empty = summarizeVersion([], [], 0, null);
const withData = summarizeVersion(
  [{ id: 'r1', key: 'k', version: 'v1', kind: 'production', model: 'm', startedAt: '2026-01-01T00:00:00.000Z', latencyMs: 100, inputTokens: 10, outputTokens: 20 }],
  [], 0,
  [{ subjectId: 'd', raterId: 'h', key: 'k', version: 'v1', value: 'up', at: '2026-01-01T00:00:00.000Z' }],
);

describe('prompt ledger report formatting', () => {
  it('prints metrics and shows — where a side has no data', () => {
    const out = formatComparison({ key: 'k', a: withData, b: empty, delta: { runs: -1, failureRate: null, latencyMs: { p50: null, p95: null }, tokens: { avgInput: null, avgOutput: null }, costUsd: { total: null, avgPerRun: null }, scores: {}, feedback: { upRatio: null }, samples: 0 } }, 'v1', 'v2');
    expect(out).toContain('Prompt: k');
    expect(out).toMatch(/latency p50 \(ms\)\s+100\s+—\s+—/);
    expect(out).toMatch(/thumbs up \/ down \(ratio\)\s+1 \/ 0 \(100\.0%\)/);
  });

  it('lists versions or says there are none', () => {
    expect(formatHistory('k', [])).toContain('No versions');
    expect(formatHistory('k', [{ version: 'v1', createdAt: '2026-01-01', summary: withData }])).toContain('v1');
  });
});
