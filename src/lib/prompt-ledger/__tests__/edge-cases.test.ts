import { describe, expect, it, vi } from 'vitest';
import {
  DuplicateRunError,
  InMemoryLedgerStore,
  LedgerValidationError,
  PromptLedger,
  UnknownVersionError,
  VersionConflictError,
  hashPromptContent,
  summarizeVersion,
} from '..';
import type { Run } from '..';

let n = 0;
const run = (o: Partial<Run> = {}): Run => ({
  id: `e${++n}`, key: 'k', version: 'v1', kind: 'eval', model: 'm',
  startedAt: '2026-01-01T00:00:00.000Z', outcome: 'succeeded', ...o,
});
const fbBase = { subjectId: 's', raterId: 'u', key: 'k', version: 'v1' };

const build = (extra: Record<string, unknown> = {}) => {
  let t = 0;
  const store = new InMemoryLedgerStore();
  const clock = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString() };
  const ledger = new PromptLedger({ store, clock, ...extra });
  return { ledger, store };
};
const withVersions = async (versions = ['v1'], extra: Record<string, unknown> = {}) => {
  const ctx = build(extra);
  for (const v of versions) await ctx.ledger.registerVersion({ key: 'k', version: v, text: `t-${v}` });
  return ctx;
};
const summaryOf = async (l: PromptLedger, version = 'v1') =>
  (await l.history('k')).find((h) => h.version === version)!.summary;

describe('hashPromptContent edge cases', () => {
  it('array order changes the hash', () => {
    expect(hashPromptContent({ text: 't', schema: [1, 2] })).not.toBe(hashPromptContent({ text: 't', schema: [2, 1] }));
  });
  it('is a 64-char hex sha256 and deterministic', () => {
    const h = hashPromptContent({ text: 't', schema: { a: 1 } });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPromptContent({ text: 't', schema: { a: 1 } })).toBe(h);
  });
  it('schema value changes the hash', () => {
    expect(hashPromptContent({ text: 't', schema: { a: 1 } })).not.toBe(hashPromptContent({ text: 't', schema: { a: 2 } }));
  });
  it('does not mutate its input', () => {
    const schema = { b: 1, a: { d: 1, c: 2 } };
    const copy = structuredClone(schema);
    hashPromptContent({ text: 't', schema });
    expect(schema).toEqual(copy);
    expect(Object.keys(schema)).toEqual(['b', 'a']);
  });
});

describe('registerVersion edge cases', () => {
  it('same version string under another key is a different version', async () => {
    const { ledger } = build();
    await ledger.registerVersion({ key: 'k1', version: 'v1', text: 'a' });
    await expect(ledger.registerVersion({ key: 'k2', version: 'v1', text: 'b' })).resolves.toMatchObject({ key: 'k2' });
  });
  it('a schema difference alone is a conflict', async () => {
    const { ledger } = build();
    await ledger.registerVersion({ key: 'k', version: 'v1', text: 'a', schema: { x: 1 } });
    await expect(ledger.registerVersion({ key: 'k', version: 'v1', text: 'a', schema: { x: 2 } })).rejects.toBeInstanceOf(VersionConflictError);
  });
  it('idempotent register keeps the original createdAt', async () => {
    const { ledger } = build();
    const first = await ledger.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    const again = await ledger.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    expect(again.createdAt).toBe(first.createdAt);
  });
  it.each([
    ['key', { key: '', version: 'v', text: 't' }],
    ['version', { key: 'k', version: '  ', text: 't' }],
    ['text', { key: 'k', version: 'v', text: 5 as never }],
  ])('rejects invalid %s with its path', async (path, input) => {
    await expect(build().ledger.registerVersion(input)).rejects.toMatchObject({ path });
  });
  it('accepts an empty text string (only type is enforced)', async () => {
    await expect(build().ledger.registerVersion({ key: 'k', version: 'v', text: '' })).resolves.toBeDefined();
  });
});

describe('recordRun failure atomicity', () => {
  it('unregistered (key, version) writes nothing and does not mirror', async () => {
    const mirror = { mirrorEvalRun: vi.fn() };
    const { ledger, store } = await withVersions(['v1'], { mirror });
    const r = run({ version: 'ghost' });
    await expect(ledger.recordRun(r, [{ metric: 'q', value: 1 }], [{ ref: 'x', mediaType: 'image/png' }])).rejects.toBeInstanceOf(UnknownVersionError);
    expect(await store.listRuns('k', 'ghost')).toEqual([]);
    expect(await store.listScores([r.id])).toEqual([]);
    expect(await store.countSamples([r.id])).toBe(0);
    expect(mirror.mirrorEvalRun).not.toHaveBeenCalled();
  });
  it('version registered under another key does not satisfy the check', async () => {
    const { ledger } = await withVersions(['v1']);
    await expect(ledger.recordRun(run({ key: 'other' }))).rejects.toBeInstanceOf(UnknownVersionError);
  });
  it('an invalid score or sample after a valid run leaves nothing behind', async () => {
    const mirror = { mirrorEvalRun: vi.fn() };
    const { ledger, store } = await withVersions(['v1'], { mirror });
    const r = run();
    await expect(ledger.recordRun(r, [{ metric: 'ok', value: 1 }, { metric: 'bad', value: Infinity }])).rejects.toBeInstanceOf(LedgerValidationError);
    await expect(ledger.recordRun(r, [{ metric: 'ok', value: 1 }], [{ ref: '', mediaType: 'x' }])).rejects.toMatchObject({ path: 'samples[0].ref' });
    expect(await store.listRuns('k', 'v1')).toEqual([]);
    expect(await store.listScores([r.id])).toEqual([]);
    expect(mirror.mirrorEvalRun).not.toHaveBeenCalled();
  });
});

describe('recordRun validation', () => {
  const cases: Array<[string, Partial<Run>]> = [
    ['run.id', { id: '' }],
    ['run.key', { key: '' }],
    ['run.version', { version: '' }],
    ['run.model', { model: ' ' }],
    ['run.provider', { provider: '' }],
    ['run.kind', { kind: 'prod' as never }],
    ['run.outcome', { outcome: 'ok' as never }],
    ['run.startedAt', { startedAt: 'not-a-date' }],
    ['run.latencyMs', { latencyMs: NaN }],
    ['run.latencyMs', { latencyMs: Infinity }],
    ['run.latencyMs', { latencyMs: -0.001 }],
    ['run.inputTokens', { inputTokens: -1 }],
    ['run.inputTokens', { inputTokens: NaN }],
    ['run.outputTokens', { outputTokens: -Infinity }],
    ['run.costUsd', { costUsd: -0.01 }],
    ['run.costUsd', { costUsd: Infinity }],
    ['run.errorCategory', { errorCategory: '' }],
    ['run.experimentId', { experimentId: '' }],
  ];
  it.each(cases)('rejects %s', async (path, override) => {
    const { ledger } = await withVersions();
    await expect(ledger.recordRun(run(override))).rejects.toMatchObject({ name: 'LedgerValidationError', path });
  });
  it('accepts zero latency/tokens/cost', async () => {
    const { ledger } = await withVersions();
    await ledger.recordRun(run({ latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }));
    expect((await summaryOf(ledger)).costUsd.total).toBe(0);
  });
  it.each([
    ['scores[0].metric', [{ metric: '', value: 1 }]],
    ['scores[0].value', [{ metric: 'q', value: Infinity }]],
    ['scores[0].value', [{ metric: 'q', value: -Infinity }]],
    ['scores[0].value', [{ metric: 'q', value: '1' as never }]],
  ])('rejects bad score at %s', async (path, scores) => {
    const { ledger } = await withVersions();
    await expect(ledger.recordRun(run(), scores)).rejects.toMatchObject({ path });
  });
  it('rejects bad sample mediaType', async () => {
    const { ledger } = await withVersions();
    await expect(ledger.recordRun(run(), [], [{ ref: 'r', mediaType: '' }])).rejects.toMatchObject({ path: 'samples[0].mediaType' });
  });
  it('accepts negative and >1 finite score values (not over-restricted)', async () => {
    const { ledger } = await withVersions();
    await ledger.recordRun(run(), [{ metric: 'q', value: -3 }, { metric: 'q', value: 5 }]);
    expect((await summaryOf(ledger)).scores.q).toEqual({ mean: 1, n: 2 });
  });
});

describe('feedback edge cases', () => {
  it.each([
    ['subjectId', { subjectId: '' }],
    ['raterId', { raterId: '' }],
    ['key', { key: '' }],
    ['version', { version: '' }],
    ['value', { value: 'meh' as never }],
    ['at', { at: 'nope' }],
  ])('rejects invalid %s', async (path, override) => {
    const { ledger } = await withVersions();
    await expect(ledger.recordFeedback({ ...fbBase, value: 'up', ...override })).rejects.toMatchObject({ path });
  });
  it('rejects feedback for an unregistered version', async () => {
    const { ledger } = await withVersions();
    await expect(ledger.recordFeedback({ ...fbBase, version: 'ghost', value: 'up' })).rejects.toBeInstanceOf(UnknownVersionError);
  });
  it('same rater on different subjects counts separately', async () => {
    const { ledger } = await withVersions();
    await ledger.recordFeedback({ ...fbBase, subjectId: 's1', value: 'up' });
    await ledger.recordFeedback({ ...fbBase, subjectId: 's2', value: 'up' });
    expect((await summaryOf(ledger)).feedback).toEqual({ up: 2, down: 0, upRatio: 1 });
  });
  it('last write wins even when flipping back and forth', async () => {
    const { ledger } = await withVersions();
    for (const value of ['up', 'down', 'up'] as const) await ledger.recordFeedback({ ...fbBase, value });
    expect((await summaryOf(ledger)).feedback).toEqual({ up: 1, down: 0, upRatio: 1 });
  });
  it('all-down feedback gives upRatio 0, not null', async () => {
    const { ledger } = await withVersions();
    await ledger.recordFeedback({ ...fbBase, value: 'down' });
    expect((await summaryOf(ledger)).feedback!.upRatio).toBe(0);
  });
});

describe('mirror edge cases', () => {
  it('sync throw never fails recordRun, reaches onMirrorError, store written first', async () => {
    const boom = new Error('sync');
    const onMirrorError = vi.fn();
    const mirror = { mirrorEvalRun: vi.fn(() => { throw boom; }) };
    const { ledger, store } = await withVersions(['v1'], { mirror, onMirrorError });
    const r = run();
    await expect(ledger.recordRun(r)).resolves.toBeUndefined();
    expect(onMirrorError).toHaveBeenCalledWith(boom, r);
    expect(await store.listRuns('k', 'v1')).toHaveLength(1);
  });
  it('throwing/rejecting mirror without onMirrorError is silently ignored', async () => {
    for (const mirrorEvalRun of [() => { throw new Error('s'); }, () => Promise.reject(new Error('a'))]) {
      const { ledger } = await withVersions(['v1'], { mirror: { mirrorEvalRun } });
      await expect(ledger.recordRun(run())).resolves.toBeUndefined();
    }
  });
  it('mirror is never called for production, even with scores', async () => {
    const mirror = { mirrorEvalRun: vi.fn() };
    const { ledger } = await withVersions(['v1'], { mirror });
    await ledger.recordRun(run({ kind: 'production' }), [{ metric: 'q', value: 1 }]);
    expect(mirror.mirrorEvalRun).not.toHaveBeenCalled();
  });
  it('store write happens before the mirror is invoked', async () => {
    let seenRuns = -1;
    const store = new InMemoryLedgerStore();
    const mirror = { mirrorEvalRun: vi.fn(async () => { seenRuns = (await store.listRuns('k', 'v1')).length; }) };
    const ledger = new PromptLedger({ store, mirror });
    await ledger.registerVersion({ key: 'k', version: 'v1', text: 't' });
    await ledger.recordRun(run());
    expect(seenRuns).toBe(1);
  });
});

describe('summarizeVersion edge cases', () => {
  const lat = (...ls: number[]) => ls.map((latencyMs) => run({ latencyMs }));
  it('single element: p50 = p95 = that value', () => {
    expect(summarizeVersion(lat(7), [], 0, []).latencyMs).toEqual({ p50: 7, p95: 7 });
  });
  it('two elements: nearest-rank p50 is the lower, p95 the upper', () => {
    expect(summarizeVersion(lat(20, 10), [], 0, []).latencyMs).toEqual({ p50: 10, p95: 20 });
  });
  it('unsorted input and caller array is not mutated', () => {
    const runs = lat(30, 10, 20);
    const ids = runs.map((r) => r.id);
    expect(summarizeVersion(runs, [], 0, []).latencyMs.p50).toBe(20);
    expect(runs.map((r) => r.id)).toEqual(ids);
  });
  it('averages ignore runs missing the field', () => {
    const runs = [run({ inputTokens: 10, costUsd: 1 }), run({ inputTokens: 30, costUsd: 3 }), run()];
    const s = summarizeVersion(runs, [], 0, []);
    expect(s.tokens).toEqual({ avgInput: 20, avgOutput: null });
    expect(s.costUsd).toEqual({ total: 4, avgPerRun: 2 });
  });
  it('failureRate = failed / runs, 0 when none failed, 1 when all failed', () => {
    expect(summarizeVersion([run(), run({ outcome: 'failed' })], [], 0, []).failureRate).toBe(0.5);
    expect(summarizeVersion([run()], [], 0, []).failureRate).toBe(0);
    expect(summarizeVersion([run({ outcome: 'failed' })], [], 0, []).failureRate).toBe(1);
  });
});

describe('compare edge cases', () => {
  it('a version with itself gives zero deltas', async () => {
    const { ledger } = await withVersions(['v1']);
    await ledger.recordRun(run({ latencyMs: 10, costUsd: 1, inputTokens: 5, outputTokens: 5 }), [{ metric: 'q', value: 0.4 }]);
    await ledger.recordFeedback({ ...fbBase, value: 'up' });
    const { delta } = await ledger.compare('k', 'v1', 'v1');
    expect(delta).toEqual({
      runs: 0, failureRate: 0, latencyMs: { p50: 0, p95: 0 }, tokens: { avgInput: 0, avgOutput: 0 },
      costUsd: { total: 0, avgPerRun: 0 }, scores: { q: 0 }, feedback: { upRatio: 0 }, samples: 0,
    });
  });
  it('two versions with no runs: all deltas null (never 0), runs delta 0', async () => {
    const { ledger } = await withVersions(['v1', 'v2']);
    const { delta } = await ledger.compare('k', 'v1', 'v2');
    expect(delta.failureRate).toBeNull();
    expect(delta.latencyMs).toEqual({ p50: null, p95: null });
    expect(delta.costUsd).toEqual({ total: null, avgPerRun: null });
    expect(delta.tokens).toEqual({ avgInput: null, avgOutput: null });
    expect(delta.feedback.upRatio).toBeNull();
    expect(delta.runs).toBe(0);
  });
  it('delta is null when only one side has data, and sign is b - a', async () => {
    const { ledger } = await withVersions(['v1', 'v2']);
    await ledger.recordRun(run({ version: 'v1', latencyMs: 10 }));
    expect((await ledger.compare('k', 'v1', 'v2')).delta.latencyMs.p50).toBeNull();
    expect((await ledger.compare('k', 'v2', 'v1')).delta.latencyMs.p50).toBeNull();
    await ledger.recordRun(run({ version: 'v2', latencyMs: 25 }));
    expect((await ledger.compare('k', 'v1', 'v2')).delta.latencyMs.p50).toBe(15);
    expect((await ledger.compare('k', 'v2', 'v1')).delta.latencyMs.p50).toBe(-15);
  });
  it('kind filter applies to scores, samples and runs', async () => {
    const { ledger } = await withVersions(['v1']);
    await ledger.recordRun(run({ kind: 'eval' }), [{ metric: 'q', value: 1 }], [{ ref: 'a', mediaType: 'x' }]);
    await ledger.recordRun(run({ kind: 'production' }), [{ metric: 'q', value: 0 }, { metric: 'p', value: 1 }], [{ ref: 'b', mediaType: 'x' }, { ref: 'c', mediaType: 'x' }]);
    const evalOnly = (await ledger.compare('k', 'v1', 'v1', { kind: 'eval' })).a;
    expect(evalOnly).toMatchObject({ runs: 1, samples: 1, scores: { q: { mean: 1, n: 1 } } });
    expect(evalOnly.scores.p).toBeUndefined();
    const prodOnly = (await ledger.compare('k', 'v1', 'v1', { kind: 'production' })).a;
    expect(prodOnly).toMatchObject({ runs: 1, samples: 2, scores: { q: { mean: 0, n: 1 }, p: { mean: 1, n: 1 } } });
  });
  it('unknown version on either side throws UnknownVersionError; same version under another key is unknown', async () => {
    const { ledger } = await withVersions(['v1']);
    await expect(ledger.compare('k', 'ghost', 'v1')).rejects.toBeInstanceOf(UnknownVersionError);
    await expect(ledger.compare('k', 'v1', 'ghost')).rejects.toBeInstanceOf(UnknownVersionError);
    await expect(ledger.compare('other', 'v1', 'v1')).rejects.toBeInstanceOf(UnknownVersionError);
  });
  it('does not mix runs of another key sharing the version string', async () => {
    const { ledger } = await withVersions(['v1']);
    await ledger.registerVersion({ key: 'k2', version: 'v1', text: 'z' });
    await ledger.recordRun(run({ key: 'k2' }));
    expect((await ledger.compare('k', 'v1', 'v1')).a.runs).toBe(0);
  });
});

describe('history edge cases', () => {
  it('orders by createdAt regardless of registration order and only returns that key', async () => {
    let t = 10;
    const clock = { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t--)).toISOString() };
    const ledger = new PromptLedger({ store: new InMemoryLedgerStore(), clock });
    await ledger.registerVersion({ key: 'k', version: 'late-registered-first', text: 'a' }); // t=10
    await ledger.registerVersion({ key: 'other', version: 'x', text: 'a' }); // t=9
    await ledger.registerVersion({ key: 'k', version: 'second-registered', text: 'b' }); // t=8 (earlier)
    const h = await ledger.history('k');
    expect(h.map((v) => v.version)).toEqual(['second-registered', 'late-registered-first']);
    expect(h.every((v) => v.key === 'k')).toBe(true);
  });
  it('unknown key gives an empty list; empty key is rejected', async () => {
    const { ledger } = build();
    expect(await ledger.history('nope')).toEqual([]);
    await expect(ledger.history('')).rejects.toMatchObject({ path: 'key' });
  });
});

describe('immutability', () => {
  it('recordRun does not mutate its inputs', async () => {
    const { ledger } = await withVersions();
    const r = run({ latencyMs: 5 });
    const scores = [{ metric: 'q', value: 1 }];
    const samples = [{ ref: 'a', mediaType: 'x' }];
    const snapshot = structuredClone({ r, scores, samples });
    await ledger.recordRun(r, scores, samples);
    expect({ r, scores, samples }).toEqual(snapshot);
  });
  it('recordFeedback does not mutate its input', async () => {
    const { ledger } = await withVersions();
    const input = { ...fbBase, value: 'up' as const };
    await ledger.recordFeedback(input);
    expect(input).toEqual({ ...fbBase, value: 'up' });
  });
  it('mutating a caller-held run after recordRun does not change store state', async () => {
    const { ledger, store } = await withVersions();
    const r = run({ latencyMs: 5 });
    await ledger.recordRun(r);
    r.latencyMs = 999;
    expect((await store.listRuns('k', 'v1'))[0].latencyMs).toBe(5);
  });
  it('mutating a returned run/version/feedback does not change store state', async () => {
    const { ledger, store } = await withVersions();
    await ledger.recordRun(run({ latencyMs: 5 }));
    await ledger.recordFeedback({ ...fbBase, value: 'up' });
    (await store.listRuns('k', 'v1'))[0].latencyMs = 999;
    (await store.listFeedback('k', 'v1'))[0].value = 'down';
    (await store.getVersion('k', 'v1'))!.contentHash = 'tampered';
    (await store.listVersions('k'))[0].version = 'tampered';
    const s = await summaryOf(ledger);
    expect(s.latencyMs.p50).toBe(5);
    expect(s.feedback!.up).toBe(1);
    await expect(ledger.registerVersion({ key: 'k', version: 'v1', text: 't-v1' })).resolves.toBeDefined();
  });
  it('mutating the record returned by registerVersion does not change the store', async () => {
    const { ledger, store } = build();
    const rec = await ledger.registerVersion({ key: 'k', version: 'v1', text: 'a' });
    rec.contentHash = 'tampered';
    expect((await store.getVersion('k', 'v1'))!.contentHash).not.toBe('tampered');
  });
});

describe('duplicate runs and throwing onMirrorError', () => {
  it('duplicate run id throws DuplicateRunError and writes nothing', async () => {
    const mirror = { mirrorEvalRun: vi.fn().mockResolvedValue(undefined) };
    const { ledger } = await withVersions(['v1'], { mirror });
    const r = run();
    await ledger.recordRun(r, [{ metric: 'q', value: 1 }], [{ ref: 'a', mediaType: 'image/png' }]);
    await expect(ledger.recordRun(r, [{ metric: 'q', value: 0 }], [{ ref: 'b', mediaType: 'image/png' }])).rejects.toBeInstanceOf(DuplicateRunError);
    const s = (await ledger.history('k'))[0].summary;
    expect(s.runs).toBe(1);
    expect(s.scores.q).toEqual({ mean: 1, n: 1 });
    expect(s.samples).toBe(1);
    expect(mirror.mirrorEvalRun).toHaveBeenCalledOnce();
  });
  it('onMirrorError throwing does not fail recordRun', async () => {
    const mirror = { mirrorEvalRun: vi.fn().mockRejectedValue(new Error('m')) };
    const onMirrorError = vi.fn(() => { throw new Error('handler'); });
    const { ledger } = await withVersions(['v1'], { mirror, onMirrorError });
    await expect(ledger.recordRun(run())).resolves.toBeUndefined();
    expect(onMirrorError).toHaveBeenCalledOnce();
  });
});

describe('atomic store contract, eval feedback, gitCommit', () => {
  it('insertRun is all-or-nothing and rejects duplicates at the store', async () => {
    const store = new InMemoryLedgerStore();
    const r = run();
    await store.insertRun(r, [{ runId: r.id, metric: 'q', value: 1 }], []);
    await expect(store.insertRun(r, [{ runId: r.id, metric: 'q', value: 9 }], [])).rejects.toBeInstanceOf(DuplicateRunError);
    expect(await store.listScores([r.id])).toHaveLength(1);
  });
  it('insertVersionIfAbsent returns the existing record', async () => {
    const store = new InMemoryLedgerStore();
    const a = { key: 'k', version: 'v1', contentHash: 'h1', createdAt: 'x' };
    await store.insertVersionIfAbsent(a);
    expect(await store.insertVersionIfAbsent({ ...a, contentHash: 'h2' })).toEqual(a);
  });
  it('eval-only compare has null feedback; production/no kind keeps it', async () => {
    const { ledger } = await withVersions(['v1', 'v2']);
    await ledger.recordFeedback({ ...fbBase, value: 'up' });
    expect((await ledger.compare('k', 'v1', 'v2', { kind: 'eval' })).a.feedback).toBeNull();
    expect((await ledger.compare('k', 'v1', 'v2', { kind: 'production' })).a.feedback).toEqual({ up: 1, down: 0, upRatio: 1 });
    expect((await ledger.compare('k', 'v1', 'v2')).a.feedback!.up).toBe(1);
  });
  it('gitCommit is stored, validated, and not part of the hash', async () => {
    const { ledger } = build();
    const rec = await ledger.registerVersion({ key: 'k', version: 'v1', text: 'a', gitCommit: 'abc' });
    expect(rec.gitCommit).toBe('abc');
    expect(rec.contentHash).toBe(hashPromptContent({ text: 'a' }));
    expect((await ledger.registerVersion({ key: 'k', version: 'v1', text: 'a', gitCommit: 'def' })).gitCommit).toBe('abc');
    await expect(ledger.registerVersion({ key: 'k', version: 'v2', text: 'a', gitCommit: '' })).rejects.toMatchObject({ path: 'gitCommit' });
  });
});
