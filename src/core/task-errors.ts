/**
 * Agent task error kinds and the error classifier (architecture §2.5).
 *
 * A failed `A2ATaskResult` carries `error.kind`, a stable machine-readable
 * string chosen by the agent, its provider adapter, or the transport. The
 * classifier maps that kind onto the persisted `agent_tasks.error_category`
 * enum (`transient | content_policy | permanent_bug`), which a future retry
 * sweeper reads to decide whether a retry can help.
 *
 * Pure and agent-agnostic: the mapping looks only at `kind`, never at the
 * agent id, the message text, or any I/O. Unknown kinds map to
 * `permanent_bug`, so an unclassified failure is never retried automatically
 * (no repeated provider spend) and stays visible for operator review.
 */

/** Persisted failure category. Mirrors the `error_category` Postgres enum. */
export type TaskErrorCategory = 'transient' | 'content_policy' | 'permanent_bug';

/** Typed error kinds producers should emit in `A2ATaskResult.error.kind`. */
export const TASK_ERROR_KINDS = [
  /** The provider refused the request or output on safety / content-policy grounds. */
  'content_policy',
  /** Required configuration (an API key, an env var) is absent. */
  'config_missing',
  /** The provider throttled the request (HTTP 429). */
  'rate_limited',
  /** The request timed out (HTTP 408/504, client abort, socket timeout). */
  'timeout',
  /** The provider is unreachable or failed server-side (HTTP 5xx, network error). */
  'provider_unavailable',
  /** The provider rejected the request as invalid or unauthorized (other HTTP 4xx). */
  'provider_rejected',
  /** The provider answered successfully but without a usable result (e.g. no image URL). */
  'invalid_output',
  /** The agent has no real implementation yet. */
  'not_implemented',
  /** The handler threw something that carried no typed kind. */
  'handler_threw',
  /** The generated asset could not be downloaded from the provider or written to object storage. */
  'storage_unavailable',
  /** KAN-43: a usage limit denied the call before the provider was reached. Retry after the window. */
  'usage_limited',
] as const;

export type TaskErrorKind = (typeof TASK_ERROR_KINDS)[number];

const CATEGORY_BY_KIND: Readonly<Record<TaskErrorKind, TaskErrorCategory>> = {
  content_policy: 'content_policy',
  config_missing: 'permanent_bug',
  rate_limited: 'transient',
  timeout: 'transient',
  provider_unavailable: 'transient',
  provider_rejected: 'permanent_bug',
  invalid_output: 'permanent_bug',
  not_implemented: 'permanent_bug',
  handler_threw: 'permanent_bug',
  storage_unavailable: 'transient',
  usage_limited: 'transient',
};

/**
 * A task `in_progress` for longer than this is considered abandoned (the process died mid-generation)
 * and is failed by the periodic recovery sweep with kind `timeout`. The one place this value lives.
 */
export const STALE_IN_PROGRESS_TASK_MS = 10 * 60 * 1000;

/** Error stored on a task the sweep failed. Stable text: never shown to users (failure-copy is). */
export const STALE_TASK_ERROR = {
  kind: 'timeout',
  message: 'The generation stopped responding and was failed by the recovery sweep.',
} as const;

/** Category for kinds the classifier does not know. Never retried automatically. */
export const DEFAULT_TASK_ERROR_CATEGORY: TaskErrorCategory = 'permanent_bug';

export function isTaskErrorKind(kind: unknown): kind is TaskErrorKind {
  return typeof kind === 'string' && (TASK_ERROR_KINDS as ReadonlyArray<string>).includes(kind);
}

/** Map a task failure's `kind` onto the persisted category. Pure. */
export function classifyTaskError(error: { readonly kind: string }): TaskErrorCategory {
  return isTaskErrorKind(error.kind) ? CATEGORY_BY_KIND[error.kind] : DEFAULT_TASK_ERROR_CATEGORY;
}

/**
 * An error that carries a typed kind. Services and handlers throw it (or any
 * error with a known string `kind` property) so transports can preserve the
 * kind when they convert a thrown error into a failed `A2ATaskResult`.
 */
export class TaskError extends Error {
  constructor(
    readonly kind: TaskErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TaskError';
  }
}

/**
 * Convert anything thrown by a handler into the `{kind, message}` of a failed
 * `A2ATaskResult`. Keeps a known `kind` property; everything else becomes
 * `handler_threw`.
 */
export function taskErrorFromThrown(err: unknown): { kind: string; message: string } {
  const kind =
    typeof err === 'object' && err !== null && 'kind' in err ? (err as { kind: unknown }).kind : undefined;
  return {
    kind: isTaskErrorKind(kind) ? kind : 'handler_threw',
    message: err instanceof Error ? err.message : String(err),
  };
}
