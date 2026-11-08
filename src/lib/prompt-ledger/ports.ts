import type { Feedback, PromptVersion, Run, RunKind, Sample, Score } from './types';

export interface LedgerStore {
  /** Atomic: stores `v` unless (key, version) exists; returns the stored record either way. */
  insertVersionIfAbsent(v: PromptVersion): Promise<PromptVersion>;
  getVersion(key: string, version: string): Promise<PromptVersion | null>;
  listVersions(key: string): Promise<PromptVersion[]>;
  /** All-or-nothing; throws DuplicateRunError when the run id already exists. */
  insertRun(run: Run, scores: Score[], samples: Sample[]): Promise<void>;
  /** Last write wins per (subjectId, raterId). */
  upsertFeedback(fb: Feedback): Promise<void>;
  listRuns(key: string, version: string, kind?: RunKind): Promise<Run[]>;
  listScores(runIds: string[]): Promise<Score[]>;
  countSamples(runIds: string[]): Promise<number>;
  listFeedback(key: string, version: string): Promise<Feedback[]>;
}

export interface ExperimentMirror {
  mirrorEvalRun(run: Run, scores: Score[]): Promise<void>;
}

export interface Clock {
  now(): string;
}
