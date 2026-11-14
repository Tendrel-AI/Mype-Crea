import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryLedgerStore,
  LedgerValidationError,
  PromptLedger,
  UnknownVersionError,
  VersionConflictError,
  hashPromptContent,
  summarizeVersion,
} from '..';
import type { Feedback, Run } from '..';

let n = 0;
const run = (o: Partial<Run> = {}): Run => ({
  id: `r${++n}`, key: 'k', version: 'v1', kind: 'eval', model: 'm',
  startedAt: '2026-01-01T00:00:00.000Z', outcome: 'succeeded', ...o,
});
const setup = (extra: Record<string, unknown> = {}) => {
  let t = 0;
  const clock = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString() };
  return new PromptLedger({ store: new InMemoryLedgerStore(), clock, ...extra });
};

describe('hash', () => {
  it('ignores key order, recursively', () => {
    const a = hashPromptContent({ text: 't', schema: { a: 1, b: { c: 2, d: [{ x: 1, y: 2 }] } } });
    const b = hashPromptContent({ text: 't', schema: { b: { d: [{ y: 2, x: 1 }], c: 2 }, a: 1 } });
    expect(a).toBe(b);
    expect(hashPromptContent({ text: 't2', schema: {} })).not.toBe(hashPromptContent({ text: 't', schema: {} }));
  });
});

describe('registerVersion', () => {
  it('is idempotent and detects conflicts', async () => {
    const l = setup();
    const first = await l.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    expect(await l.registerVersion({ key: 'k', version: 'v1', text: 'a' })).toEqual(first);
    await expect(l.registerVersion({ key: 'k', version: 'v1', text: 'b' })).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('recordRun', () => {
  it('rejects unknown versions and invalid input with the field path', async () => {
    const l = setup();
    await expect(l.recordRun(run())).rejects.toBeInstanceOf(UnknownVersionError);
    await l.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    await expect(l.recordRun(run({ latencyMs: -1 }))).rejects.toMatchObject({ path: 'run.latencyMs' });
    await expect(l.recordRun(run({ kind: 'x' as never }))).rejects.toBeInstanceOf(LedgerValidationError);
    await expect(l.recordRun(run(), [{ metric: 'm', value: NaN }])).rejects.toMatchObject({ path: 'scores[0].value' });
    await expect(l.recordRun(run({ model: '' }))).rejects.toMatchObject({ path: 'run.model' });
  });

  it('mirrors eval runs only, and mirror errors never fail the run', async () => {
    const mirror = { mirrorEvalRun: vi.fn().mockResolvedValue(undefined) };
    const l = setup({ mirror });
    await l.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    await l.recordRun(run({ kind: 'production' }));
    expect(mirror.mirrorEvalRun).not.toHaveBeenCalled();
    await l.recordRun(run({ kind: 'eval' }), [{ metric: 'q', value: 1 }]);
    expect(mirror.mirrorEvalRun).toHaveBeenCalledOnce();
    expect(mirror.mirrorEvalRun.mock.calls[0][1]).toHaveLength(1);

    const boom = new Error('boom');
    const onMirrorError = vi.fn();
    const l2 = setup({ mirror: { mirrorEvalRun: vi.fn().mockRejectedValue(boom) }, onMirrorError });
    await l2.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    const r = run();
    await expect(l2.recordRun(r)).resolves.toBeUndefined();
    expect(onMirrorError).toHaveBeenCalledWith(boom, r);
    expect((await l2.history('k'))[0].summary.runs).toBe(1); // store written before the mirror
  });
});

describe('feedback', () => {
  it('last write wins per (subjectId, raterId)', async () => {
    const l = setup();
    await l.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    const fb = { subjectId: 's', raterId: 'u', key: 'k', version: 'v1' };
    await l.recordFeedback({ ...fb, value: 'up' });
    await l.recordFeedback({ ...fb, value: 'down' });
    await l.recordFeedback({ ...fb, raterId: 'u2', value: 'up' });
    const { feedback } = (await l.history('k'))[0].summary;
    expect(feedback).toEqual({ up: 1, down: 1, upRatio: 0.5 });
  });
});

describe('summarizeVersion', () => {
  it('returns nulls for empty data', () => {
    const s = summarizeVersion([], [], 0, []);
    expect(s).toEqual({
      runs: 0, failureRate: null, latencyMs: { p50: null, p95: null },
      tokens: { avgInput: null, avgOutput: null }, costUsd: { total: null, avgPerRun: null },
      scores: {}, feedback: { up: 0, down: 0, upRatio: null }, samples: 0,
    });
  });

  it('computes nearest-rank percentiles and ignores missing fields', () => {
    const runs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((latencyMs) => run({ latencyMs }));
    runs.push(run({ outcome: 'failed' })); // no latency/cost: must not count as 0
    const s = summarizeVersion(runs, [], 0, [] as Feedback[]);
    expect(s.latencyMs).toEqual({ p50: 50, p95: 100 });
    expect(s.failureRate).toBeCloseTo(1 / 11);
    expect(s.costUsd.total).toBeNull();
  });
});

describe('compare', () => {
  it('returns b - a, null where a side has no data, and filters by kind', async () => {
    const l = setup();
    await l.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    await l.registerVersion({ key: 'k', version: 'v2', text: 'b' });
    await l.recordRun(run({ version: 'v1', latencyMs: 100, costUsd: 1 }), [{ metric: 'q', value: 0.5 }]);
    await l.recordRun(run({ version: 'v2', latencyMs: 60, costUsd: 3 }), [{ metric: 'q', value: 1 }, { metric: 'z', value: 1 }]);
    await l.recordRun(run({ version: 'v2', kind: 'production', latencyMs: 1000 }));
    const c = await l.compare('k', 'v1', 'v2', { kind: 'eval' });
    expect(c.delta.latencyMs.p50).toBe(-40);
    expect(c.delta.costUsd.total).toBe(2);
    expect(c.delta.scores).toEqual({ q: 0.5, z: null });
    expect(c.delta.feedback.upRatio).toBeNull();
    expect(c.b.runs).toBe(1);
    expect((await l.compare('k', 'v1', 'v2')).b.runs).toBe(2);
    await expect(l.compare('k', 'v1', 'nope')).rejects.toBeInstanceOf(UnknownVersionError);
  });
});

