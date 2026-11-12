/**
 * MYPES Platform — Notification contract (KAN-58)
 * ================================================
 *
 * THE single definition of every notification the platform moves between
 * processes: what each kind carries, how it is serialized, how it is parsed
 * back, and which wire it travels on (Redis Pub/Sub channel, durable
 * `ai_turn_events` outbox row, SSE frame).
 *
 * Rule: every producer builds a notification with `notification(kind, payload)`
 * and writes it with `serializeNotification`; every consumer reads it with
 * `parseNotification`, which rejects (never throws on) malformed JSON, an
 * unsupported contract version, an unknown or unexpected kind, and a payload
 * that does not match its schema. Changing a payload means editing
 * `NotificationPayloads` and its schema below; the compiler then points at
 * every producer and consumer that has to follow.
 *
 * Wire shape (flat envelope): `{ v: NOTIFICATION_CONTRACT_VERSION, kind, ...payload }`.
 * Bump the version when a change is not backward compatible; parsers reject
 * other versions.
 *
 * Pure: no I/O, no Node APIs, no logger. Rejections are returned so the
 * caller logs them with its own context. The browser imports this module
 * too (the SSE consumer in `components/CreaMype.tsx`).
 *
 * Failure detail policy: `task_failed.detail` (error category, kind, sanitized
 * message) is technical. It is stored in the durable outbox, but the SSE
 * edge removes it with `toClientNotification` unless the server-side policy
 * (`src/services/failure-disclosure.ts`) allows it.
 */

import { z } from 'zod';
import type { A2AArtifact } from '../agent-types';
import type { TaskErrorCategory } from '../task-errors';
import type { PlannerDecision } from './decisions';
import type { AgentId, ConversationId, DeliverableId, ISOTimestamp, TaskId, UUID } from './ids';

/** Version stamped on every serialized notification (`v`). */
export const NOTIFICATION_CONTRACT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Payloads — the one place a notification's fields are declared
// ---------------------------------------------------------------------------

/** An artifact as stored in a durable completion notice. */
export interface NotificationArtifact {
  readonly kind: string;
  readonly url: string | null;
  readonly inline: unknown;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Technical detail of a failed task. Developer-only on the client: the SSE
 * edge strips it unless the failure-disclosure policy allows it.
 */
export interface TaskFailureDetail {
  readonly errorCategory: TaskErrorCategory;
  /** `A2ATaskResult.error.kind` (see `TASK_ERROR_KINDS`). */
  readonly errorKind: string;
  /** Sanitized with `sanitizeFailureMessage` (no secrets, no query strings, bounded). */
  readonly message: string;
}

export interface NotificationPayloads {
  /** Planner decision wake-up (server-internal; never forwarded to the browser). */
  readonly decision: {
    readonly conversationId: ConversationId;
    readonly decision: PlannerDecision;
  };
  /** Artifacts a settled task produced (server-internal side channel of the core). */
  readonly artifact_published: {
    readonly conversationId: ConversationId;
    readonly agentId: AgentId;
    readonly taskId: TaskId;
    readonly artifacts: ReadonlyArray<A2AArtifact>;
  };
  /** A worker claimed the task and started the handler (ephemeral; also an SSE frame). */
  readonly task_processing: {
    readonly conversationId: ConversationId;
    readonly agentId: AgentId;
    readonly taskId: TaskId;
    readonly claimedAt: ISOTimestamp;
  };
  /** Durable completion notice (outbox `artifact` row; SSE frame). */
  readonly task_completed: {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    readonly deliverableIds: ReadonlyArray<DeliverableId>;
    readonly artifacts: ReadonlyArray<NotificationArtifact>;
  };
  /** Durable failure notice (outbox `notice` row; SSE frame). */
  readonly task_failed: {
    readonly taskId: TaskId;
    readonly agentId: AgentId;
    /** Present in storage; removed at the SSE edge unless the policy allows it. */
    readonly detail?: TaskFailureDetail;
  };
  /** Wake-up for an agent worker. A trigger only: the worker re-reads the row. */
  readonly task_dispatch: {
    readonly taskId: TaskId;
    readonly tenantId: UUID;
    readonly agentId: AgentId;
  };
}

export type NotificationKind = keyof NotificationPayloads;
export type NotificationPayload<K extends NotificationKind> = NotificationPayloads[K];
export type NotificationOf<K extends NotificationKind> = {
  readonly v: typeof NOTIFICATION_CONTRACT_VERSION;
  readonly kind: K;
} & NotificationPayloads[K];
export type Notification = { [K in NotificationKind]: NotificationOf<K> }[NotificationKind];

// ---------------------------------------------------------------------------
// Schemas — `satisfies` ties each one to its payload type above
// ---------------------------------------------------------------------------

const PLANNER_DECISION_KINDS: ReadonlyArray<PlannerDecision['kind']> = [
  'request_fields',
  'confirm_field',
  'request_selection',
  'offer_generation',
  'request_upload',
  'announce_dispatch',
  'announce_completion',
  'report_deliverable_status',
  'announce_all_complete',
];

/** Shallow guard: known kind, and an `agentId` string wherever the variant has one. */
function isPlannerDecisionShape(value: unknown): value is PlannerDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { kind, agentId } = value as { kind?: unknown; agentId?: unknown };
  if (typeof kind !== 'string' || !(PLANNER_DECISION_KINDS as ReadonlyArray<string>).includes(kind)) return false;
  return kind === 'announce_all_complete' || (typeof agentId === 'string' && agentId.length > 0);
}

const id = z.string().min(1);
const errorCategory = z.enum(['transient', 'content_policy', 'permanent_bug']) satisfies z.ZodType<TaskErrorCategory>;

const a2aArtifact = z.object({
  kind: z.string(),
  inline: z.unknown().optional(),
  url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<A2AArtifact>;

const notificationArtifact = z.object({
  kind: z.string(),
  url: z.string().nullable(),
  inline: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<NotificationArtifact>;

const failureDetail = z.object({
  errorCategory,
  errorKind: z.string(),
  message: z.string(),
}) satisfies z.ZodType<TaskFailureDetail>;

const PAYLOAD_SCHEMAS: { readonly [K in NotificationKind]: z.ZodType<NotificationPayloads[K]> } = {
  decision: z.object({
    conversationId: id,
    decision: z.custom<PlannerDecision>(isPlannerDecisionShape, 'invalid planner decision'),
  }),
  artifact_published: z.object({
    conversationId: id,
    agentId: id,
    taskId: id,
    artifacts: z.array(a2aArtifact),
  }),
  task_processing: z.object({
    conversationId: id,
    agentId: id,
    taskId: id,
    claimedAt: z.string(),
  }),
  task_completed: z.object({
    taskId: id,
    agentId: id,
    deliverableIds: z.array(id),
    artifacts: z.array(notificationArtifact),
  }),
  task_failed: z.object({
    taskId: id,
    agentId: id,
    detail: failureDetail.optional(),
  }),
  task_dispatch: z.object({
    taskId: id,
    tenantId: id,
    agentId: id,
  }),
};

export const NOTIFICATION_KINDS = Object.keys(PAYLOAD_SCHEMAS) as ReadonlyArray<NotificationKind>;

// ---------------------------------------------------------------------------
// Build, serialize, parse
// ---------------------------------------------------------------------------

/** Build a notification of `kind`. The only way producers create one. */
export function notification<K extends NotificationKind>(kind: K, payload: NotificationPayloads[K]): NotificationOf<K> {
  return { ...payload, v: NOTIFICATION_CONTRACT_VERSION, kind } as NotificationOf<K>;
}

/** The payload without the envelope fields (`v`, `kind`). */
export function payloadOf<K extends NotificationKind>(n: NotificationOf<K>): NotificationPayloads[K] {
  const { v: _v, kind: _kind, ...payload } = n as NotificationOf<K> & Record<string, unknown>;
  return payload as unknown as NotificationPayloads[K];
}

/** JSON text for a Redis message, an SSE `data:` line, or a test fixture. */
export function serializeNotification<K extends NotificationKind>(n: NotificationOf<K>): string {
  return JSON.stringify(n);
}

/** Plain JSON object for a durable outbox row (`ai_turn_events.payload`). */
export function notificationToJson<K extends NotificationKind>(n: NotificationOf<K>): Record<string, unknown> {
  return JSON.parse(serializeNotification(n)) as Record<string, unknown>;
}

export type NotificationRejection =
  | 'invalid_json'
  | 'not_an_object'
  | 'unsupported_version'
  | 'unknown_kind'
  | 'unexpected_kind'
  | 'invalid_payload';

export type ParsedNotification<K extends NotificationKind = NotificationKind> =
  | { readonly ok: true; readonly notification: { [P in K]: NotificationOf<P> }[K] }
  | { readonly ok: false; readonly reason: NotificationRejection; readonly detail?: string };

/**
 * Parse a serialized notification (JSON text) or an already-decoded object
 * (a JSONB column). With `expected`, any other kind is `unexpected_kind`.
 * Never throws. Unknown payload fields are dropped.
 */
export function parseNotification<K extends NotificationKind = NotificationKind>(
  input: unknown,
  expected?: ReadonlyArray<K>,
): ParsedNotification<K> {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const { v, kind, ...rest } = value as Record<string, unknown>;
  if (v !== NOTIFICATION_CONTRACT_VERSION) {
    return { ok: false, reason: 'unsupported_version', detail: String(v) };
  }
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, kind)) {
    return { ok: false, reason: 'unknown_kind', detail: String(kind) };
  }
  if (expected && !(expected as ReadonlyArray<string>).includes(kind)) {
    return { ok: false, reason: 'unexpected_kind', detail: kind };
  }
  const result = PAYLOAD_SCHEMAS[kind as NotificationKind].safeParse(rest);
  if (!result.success) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    };
  }
  return {
    ok: true,
    notification: notification(kind as K, result.data as NotificationPayloads[K]) as { [P in K]: NotificationOf<P> }[K],
  };
}

// ---------------------------------------------------------------------------
// Wires — which kind travels where
// ---------------------------------------------------------------------------

/** Kinds carried on Redis Pub/Sub, with the channel prefix and the id that scopes the channel. */
const REDIS_WIRES = {
  decision: { prefix: 'mypes:decision:', scope: (p: NotificationPayloads['decision']) => p.conversationId },
  artifact_published: {
    prefix: 'mypes:artifact:',
    scope: (p: NotificationPayloads['artifact_published']) => p.conversationId,
  },
  task_processing: {
    prefix: 'mypes:lifecycle:processing:',
    scope: (p: NotificationPayloads['task_processing']) => p.conversationId,
  },
  task_dispatch: { prefix: 'mypes:agent_task:dispatch:', scope: (p: NotificationPayloads['task_dispatch']) => p.agentId },
} as const;

export type RedisNotificationKind = keyof typeof REDIS_WIRES;

/** Redis channel for a kind scoped to a conversation id (or, for `task_dispatch`, an agent id). */
export function redisChannelName(kind: RedisNotificationKind, scopeId: string): string {
  return `${REDIS_WIRES[kind].prefix}${scopeId}`;
}

/** Redis channel a notification is published on (derived from its own payload). */
export function redisChannelFor(n: NotificationOf<RedisNotificationKind>): string {
  const wire = REDIS_WIRES[n.kind] as { prefix: string; scope: (p: unknown) => string };
  return `${wire.prefix}${wire.scope(n)}`;
}

/** The scope id of a channel of `kind`, or null when the channel belongs to another kind. */
export function redisChannelScope(kind: RedisNotificationKind, channel: string): string | null {
  const { prefix } = REDIS_WIRES[kind];
  if (!channel.startsWith(prefix)) return null;
  const scope = channel.slice(prefix.length);
  return scope.length > 0 ? scope : null;
}

/** Durable outbox wires (`ai_turn_events`): the row `kind` and the event-id suffix. */
const DURABLE_WIRES = {
  task_completed: { outboxKind: 'artifact', eventSuffix: 'announce_completion' },
  task_failed: { outboxKind: 'notice', eventSuffix: 'announce_failure' },
} as const;

export type DurableNotificationKind = keyof typeof DURABLE_WIRES;
export const DURABLE_NOTIFICATION_KINDS = Object.keys(DURABLE_WIRES) as ReadonlyArray<DurableNotificationKind>;

/** Deterministic outbox identity: one notice per settled task. */
export function durableEventFor(n: NotificationOf<DurableNotificationKind>): {
  readonly outboxKind: (typeof DURABLE_WIRES)[DurableNotificationKind]['outboxKind'];
  readonly eventId: string;
} {
  const wire = DURABLE_WIRES[n.kind];
  return { outboxKind: wire.outboxKind, eventId: `${n.taskId}:${wire.eventSuffix}` };
}

/** Event-id suffix for a durable kind (used by the SQL that finds missing notices). */
export function durableEventSuffix(kind: DurableNotificationKind): string {
  return DURABLE_WIRES[kind].eventSuffix;
}

/** Kinds the browser receives over SSE. The SSE `event:` name is the kind itself. */
export const CLIENT_NOTIFICATION_KINDS = ['task_processing', 'task_completed', 'task_failed'] as const satisfies ReadonlyArray<NotificationKind>;
export type ClientNotificationKind = (typeof CLIENT_NOTIFICATION_KINDS)[number];
export type ClientNotification = { [K in ClientNotificationKind]: NotificationOf<K> }[ClientNotificationKind];

export interface ClientNotificationPolicy {
  /** From `exposesTaskFailureDetail()` (server-side). False strips `task_failed.detail`. */
  readonly exposeFailureDetail: boolean;
}

/** The version of a notification the browser may see. Applied at the SSE edge only. */
export function toClientNotification(n: ClientNotification, policy: ClientNotificationPolicy): ClientNotification {
  if (n.kind !== 'task_failed') return n;
  const { detail, ...rest } = n;
  if (!policy.exposeFailureDetail || !detail) return rest;
  return { ...rest, detail: { ...detail, message: sanitizeFailureMessage(detail.message) } };
}

// ---------------------------------------------------------------------------
// Failure detail helpers
// ---------------------------------------------------------------------------

/** Longest sanitized failure message, in code points. */
export const MAX_FAILURE_MESSAGE_LENGTH = 300;

/** [pattern, replacement] pairs applied in order; each leaves `[redacted]` where a secret was. */
const SECRET_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/\b(api[_-]?key|key|token|secret|password|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b[A-Za-z0-9+_-]{32,}={0,2}/g, '[redacted]'],
];

/**
 * Make a provider/handler error message safe to show a developer: no control
 * characters, no URL query strings or fragments, no token-looking strings,
 * single-spaced and at most `MAX_FAILURE_MESSAGE_LENGTH` code points.
 * Idempotent.
 */
export function sanitizeFailureMessage(message: string): string {
  let text = message.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  text = text.replace(/(\bhttps?:\/\/[^\s?#]+)[?#]\S*/gi, '$1');
  for (const [pattern, replacement] of SECRET_REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  const points = [...text];
  return points.length > MAX_FAILURE_MESSAGE_LENGTH
    ? `${points.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1).join('')}…`
    : text;
}

/** Build the durable failure detail from a failed task's error. */
export function taskFailureDetail(
  error: { readonly kind: string; readonly message: string },
  category: TaskErrorCategory,
): TaskFailureDetail {
  return { errorCategory: category, errorKind: error.kind, message: sanitizeFailureMessage(error.message) };
}
