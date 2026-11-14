import { buildComparison, summarizeVersion } from './compare';
import { LedgerValidationError, UnknownVersionError, VersionConflictError } from './errors';
import { hashPromptContent } from './hash';
import type { Clock, ExperimentMirror, LedgerStore } from './ports';
import type { Comparison, Feedback, PromptVersion, Run, RunKind, Sample, Score, VersionSummary } from './types';
import { finite, isoDate, nonNeg, oneOf, optStr, str } from './validate';

export interface PromptLedgerOptions {
  store: LedgerStore;
  clock?: Clock;
  mirror?: ExperimentMirror;
  onMirrorError?: (err: unknown, run: Run) => void;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

export class PromptLedger {
  private readonly store: LedgerStore;
  private readonly clock: Clock;
  private readonly mirror?: ExperimentMirror;
  private readonly onMirrorError: (err: unknown, run: Run) => void;

  constructor(opts: PromptLedgerOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? systemClock;
    this.mirror = opts.mirror;
    this.onMirrorError = opts.onMirrorError ?? (() => {});
  }

  /** Idempotent per (key, version); a different content under the same version is a bug upstream. */
  async registerVersion(input: { key: string; version: string; text: string; schema?: unknown; gitCommit?: string }): Promise<PromptVersion> {
    str('key', input.key);
    str('version', input.version);
    if (typeof input.text !== 'string') throw new LedgerValidationError('text', 'must be a string');
    const contentHash = hashPromptContent({ text: input.text, schema: input.schema });
    optStr('gitCommit', input.gitCommit);
    const candidate: PromptVersion = { key: input.key, version: input.version, contentHash, createdAt: this.clock.now() };
    if (input.gitCommit !== undefined) candidate.gitCommit = input.gitCommit;
    const stored = await this.store.insertVersionIfAbsent(candidate);
    if (stored.contentHash !== contentHash) throw new VersionConflictError(input.key, input.version);
    return stored;
  }

  async recordRun(
    run: Run,
    scores: Array<Pick<Score, 'metric' | 'value'>> = [],
    samples: Array<Pick<Sample, 'ref' | 'mediaType'>> = [],
  ): Promise<void> {
    validateRun(run);
    const fullScores = scores.map((s, i) => {
      str(`scores[${i}].metric`, s.metric);
      finite(`scores[${i}].value`, s.value);
      return { runId: run.id, metric: s.metric, value: s.value };
    });
    const fullSamples = samples.map((s, i) => {
      str(`samples[${i}].ref`, s.ref);
      str(`samples[${i}].mediaType`, s.mediaType);
      return { runId: run.id, ref: s.ref, mediaType: s.mediaType };
    });
    if (!(await this.store.getVersion(run.key, run.version))) throw new UnknownVersionError(run.key, run.version);

    await this.store.insertRun(run, fullScores, fullSamples);

    // Store first; the mirror is best-effort and eval-only.
    if (run.kind === 'eval' && this.mirror) {
      try {
        await this.mirror.mirrorEvalRun(run, fullScores);
      } catch (err) {
        try {
          this.onMirrorError(err, run);
        } catch {
          // mirror failures never fail a run, even if the handler itself throws
        }
      }
    }
  }

  async recordFeedback(input: Omit<Feedback, 'at'> & { at?: string }): Promise<void> {
    str('subjectId', input.subjectId);
    str('raterId', input.raterId);
    str('key', input.key);
    str('version', input.version);
    oneOf('value', input.value, ['up', 'down']);
    if (input.at !== undefined) isoDate('at', input.at);
    if (!(await this.store.getVersion(input.key, input.version))) throw new UnknownVersionError(input.key, input.version);
    await this.store.upsertFeedback({
      subjectId: input.subjectId,
      raterId: input.raterId,
      key: input.key,
      version: input.version,
      value: input.value,
      at: input.at ?? this.clock.now(),
    });
  }

  async history(key: string): Promise<Array<PromptVersion & { summary: VersionSummary }>> {
    str('key', key);
    const versions = (await this.store.listVersions(key)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Promise.all(versions.map(async (v) => ({ ...v, summary: await this.summarize(key, v.version) })));
  }

  async compare(key: string, versionA: string, versionB: string, opts: { kind?: RunKind } = {}): Promise<Comparison> {
    str('key', key);
    for (const v of [versionA, versionB]) {
      str('version', v);
      if (!(await this.store.getVersion(key, v))) throw new UnknownVersionError(key, v);
    }
    const [a, b] = await Promise.all([this.summarize(key, versionA, opts.kind), this.summarize(key, versionB, opts.kind)]);
    return buildComparison(key, a, b);
  }

  private async summarize(key: string, version: string, kind?: RunKind): Promise<VersionSummary> {
    const runs = await this.store.listRuns(key, version, kind);
    const ids = runs.map((r) => r.id);
    // Feedback is a production signal: not part of eval-only summaries.
    const [scores, samples, feedback] = await Promise.all([
      this.store.listScores(ids),
      this.store.countSamples(ids),
      kind === 'eval' ? Promise.resolve(null) : this.store.listFeedback(key, version),
    ]);
    return summarizeVersion(runs, scores, samples, feedback);
  }
}

function validateRun(run: Run) {
  str('run.id', run.id);
  str('run.key', run.key);
  str('run.version', run.version);
  oneOf('run.kind', run.kind, ['eval', 'production']);
  str('run.model', run.model);
  optStr('run.provider', run.provider);
  isoDate('run.startedAt', run.startedAt);
  nonNeg('run.latencyMs', run.latencyMs);
  nonNeg('run.inputTokens', run.inputTokens);
  nonNeg('run.outputTokens', run.outputTokens);
  nonNeg('run.costUsd', run.costUsd);
  if (run.outcome !== undefined || run.kind === 'eval') oneOf('run.outcome', run.outcome, ['succeeded', 'failed']);
  optStr('run.errorCategory', run.errorCategory);
  optStr('run.experimentId', run.experimentId);
}
