export type RunKind = 'eval' | 'production';
export type RunOutcome = 'succeeded' | 'failed';
export type FeedbackValue = 'up' | 'down';

export interface PromptVersion {
  key: string;
  version: string;
  contentHash: string;
  createdAt: string;
  /** Provenance only; not part of contentHash. */
  gitCommit?: string;
}

export interface Run {
  id: string;
  key: string;
  version: string;
  kind: RunKind;
  model: string;
  provider?: string;
  startedAt: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** undefined = unknown (production calls only log completed calls); required for eval runs. */
  outcome?: RunOutcome;
  errorCategory?: string;
  experimentId?: string;
}

export interface Score {
  runId: string;
  metric: string;
  value: number;
}

/** `ref` is an opaque reference (storage key / id), never content. */
export interface Sample {
  runId: string;
  ref: string;
  mediaType: string;
}

export interface Feedback {
  subjectId: string;
  raterId: string;
  key: string;
  version: string;
  value: FeedbackValue;
  at: string;
}

export interface VersionSummary {
  runs: number;
  failureRate: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  tokens: { avgInput: number | null; avgOutput: number | null };
  costUsd: { total: number | null; avgPerRun: number | null };
  scores: Record<string, { mean: number; n: number }>;
  /** null for eval-only summaries (feedback is a production signal). */
  feedback: { up: number; down: number; upRatio: number | null } | null;
  samples: number;
}

/** b - a; null when either side has no data. */
export interface SummaryDelta {
  runs: number;
  failureRate: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  tokens: { avgInput: number | null; avgOutput: number | null };
  costUsd: { total: number | null; avgPerRun: number | null };
  scores: Record<string, number | null>;
  feedback: { upRatio: number | null };
  samples: number;
}

export interface Comparison {
  key: string;
  a: VersionSummary;
  b: VersionSummary;
  delta: SummaryDelta;
}
