/**
 * Unit tests for the notification contract (KAN-58): one round trip per
 * kind, every rejection path, the client projection that keeps failure
 * detail developer-only, the failure-message sanitizer, and the wire maps.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NOTIFICATION_KINDS,
  MAX_FAILURE_MESSAGE_LENGTH,
  NOTIFICATION_CONTRACT_VERSION,
  NOTIFICATION_KINDS,
  durableEventFor,
  notification,
  notificationToJson,
  parseNotification,
  payloadOf,
  redisChannelFor,
  redisChannelName,
  redisChannelScope,
  sanitizeFailureMessage,
  serializeNotification,
  taskFailureDetail,
  toClientNotification,
  type ClientNotification,
  type NotificationKind,
  type NotificationPayload,
} from '../contracts/notifications';

const CONVERSATION = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-0000000000t1';
const DELIVERABLE = '00000000-0000-4000-8000-0000000000d1';

/** One valid payload per kind. The mapped type fails to compile when a kind is added without a fixture. */
const FIXTURES: { readonly [K in NotificationKind]: NotificationPayload<K> } = {
  decision: {
    conversationId: CONVERSATION,
    decision: { kind: 'announce_dispatch', agentId: 'logo-agent', taskId: TASK },
  },
  artifact_published: {
    conversationId: CONVERSATION,
    agentId: 'logo-agent',
    taskId: TASK,
    artifacts: [{ kind: 'image', url: 'https://cdn.test/logo.png', metadata: { provider: 'fake' } }],
  },
  task_processing: {
    conversationId: CONVERSATION,
    agentId: 'logo-agent',
    taskId: TASK,
    claimedAt: '2026-10-25T00:00:00.000Z',
  },
  task_completed: {
    taskId: TASK,
    agentId: 'logo-agent',
    deliverableIds: [DELIVERABLE],
    artifacts: [{ kind: 'image', url: 'https://cdn.test/logo.png', inline: null, metadata: {} }],
  },
  task_failed: {
    taskId: TASK,
    agentId: 'logo-agent',
    detail: { errorCategory: 'transient', errorKind: 'timeout', message: 'fal timed out after 60s' },
  },
  task_dispatch: {
    taskId: TASK,
    tenantId: '00000000-0000-4000-8000-0000000000a1',
    agentId: 'logo-agent',
  },
};

describe('notification contract — round trip', () => {
  it('covers every kind', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it.each(NOTIFICATION_KINDS)('%s survives serialize → parse unchanged (text and JSONB object)', (kind) => {
    const n = notification(kind, FIXTURES[kind] as never);
    expect(n).toMatchObject({ v: NOTIFICATION_CONTRACT_VERSION, kind });

    const fromText = parseNotification(serializeNotification(n));
    expect(fromText).toEqual({ ok: true, notification: n });

    const fromObject = parseNotification(notificationToJson(n), [kind]);
    expect(fromObject).toEqual({ ok: true, notification: n });

    if (fromText.ok) expect(payloadOf(fromText.notification)).toEqual(FIXTURES[kind]);
  });

  it('a failed notice without detail is valid (the client view)', () => {
    const n = notification('task_failed', { taskId: TASK, agentId: 'logo-agent' });
    expect(parseNotification(serializeNotification(n))).toEqual({ ok: true, notification: n });
  });

  it('the envelope cannot be overridden by a payload field', () => {
    const n = notification('task_processing', { ...FIXTURES.task_processing, kind: 'decision', v: 9 } as never);
    expect(n.kind).toBe('task_processing');
    expect(n.v).toBe(NOTIFICATION_CONTRACT_VERSION);
  });

  it('drops unknown payload fields', () => {
    const raw = { ...notification('task_dispatch', FIXTURES.task_dispatch), requirements: { secret: 1 } };
    const parsed = parseNotification(JSON.stringify(raw));
    expect(parsed.ok && parsed.notification).not.toHaveProperty('requirements');
  });
});

describe('notification contract — rejections (never throws)', () => {
  const valid = notificationToJson(notification('task_processing', FIXTURES.task_processing));

  it.each([
    ['invalid JSON', '{not json', 'invalid_json'],
    ['a JSON array', '[]', 'not_an_object'],
    ['null', null, 'not_an_object'],
    ['a number', 42, 'not_an_object'],
    ['a payload without version (pre-contract shape)', { type: 'agent_completed', taskId: TASK, agentId: 'logo-agent' }, 'unsupported_version'],
    ['another contract version', { ...valid, v: 2 }, 'unsupported_version'],
    ['an unknown kind', { ...valid, kind: 'task_exploded' }, 'unknown_kind'],
    ['a prototype key as kind', { ...valid, kind: 'toString' }, 'unknown_kind'],
    ['a missing field', { ...valid, taskId: undefined }, 'invalid_payload'],
    ['an empty id', { ...valid, agentId: '' }, 'invalid_payload'],
    ['a wrong field type', { ...valid, claimedAt: 7 }, 'invalid_payload'],
  ])('rejects %s', (_label, input, reason) => {
    expect(parseNotification(input)).toMatchObject({ ok: false, reason });
  });

  it('rejects a kind outside the expected set', () => {
    expect(parseNotification(valid, ['task_dispatch'])).toMatchObject({
      ok: false,
      reason: 'unexpected_kind',
      detail: 'task_processing',
    });
  });

  it.each([
    ['an unknown decision kind', { kind: 'launch_rockets', agentId: 'logo-agent' }],
    ['a decision without agentId', { kind: 'request_fields', fields: [] }],
    ['a non-object decision', 'announce_dispatch'],
  ])('rejects %s', (_label, decision) => {
    const raw = { v: NOTIFICATION_CONTRACT_VERSION, kind: 'decision', conversationId: CONVERSATION, decision };
    expect(parseNotification(raw)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['an unknown error category', { errorCategory: 'meh', errorKind: 'timeout', message: 'x' }],
    ['a detail without message', { errorCategory: 'transient', errorKind: 'timeout' }],
  ])('rejects a failed notice with %s', (_label, detail) => {
    const raw = { v: NOTIFICATION_CONTRACT_VERSION, kind: 'task_failed', taskId: TASK, agentId: 'logo-agent', detail };
    expect(parseNotification(raw)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects completed artifacts in the transport shape (url must be present, nullable)', () => {
    const raw = {
      v: NOTIFICATION_CONTRACT_VERSION,
      kind: 'task_completed',
      taskId: TASK,
      agentId: 'logo-agent',
      deliverableIds: [],
      artifacts: [{ kind: 'image' }],
    };
    expect(parseNotification(raw)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
});

describe('toClientNotification — failure detail is developer-only', () => {
  const failed = notification('task_failed', FIXTURES.task_failed);

  it('strips the detail when the policy does not expose it', () => {
    expect(toClientNotification(failed, { exposeFailureDetail: false })).toEqual({
      v: NOTIFICATION_CONTRACT_VERSION,
      kind: 'task_failed',
      taskId: TASK,
      agentId: 'logo-agent',
    });
  });

  it('keeps it (sanitized) when the policy exposes it', () => {
    const leaky = notification('task_failed', {
      taskId: TASK,
      agentId: 'logo-agent',
      detail: { errorCategory: 'permanent_bug', errorKind: 'provider_rejected', message: 'HTTP 401 Bearer abc.def-123' },
    });
    expect(toClientNotification(leaky, { exposeFailureDetail: true })).toMatchObject({
      detail: { errorCategory: 'permanent_bug', errorKind: 'provider_rejected', message: 'HTTP 401 Bearer [redacted]' },
    });
  });

  it('leaves the other client kinds untouched', () => {
    for (const kind of CLIENT_NOTIFICATION_KINDS.filter((k) => k !== 'task_failed')) {
      const n = notification(kind, FIXTURES[kind] as never) as ClientNotification;
      expect(toClientNotification(n, { exposeFailureDetail: false })).toBe(n);
    }
  });
});

describe('sanitizeFailureMessage', () => {
  it.each([
    ['Request failed: Bearer sk-live_abcdefghijkl', 'Request failed: Bearer [redacted]'],
    ['api_key=supersecret&x=1 rejected', 'api_key=[redacted]&x=1 rejected'],
    ['token: "abc def"', 'token: [redacted]'],
    ['used sk-proj-ABCDEFGH1234 here', 'used [redacted] here'],
    ['GET https://queue.fal.run/fal-ai/flux?fal_key=xyz#frag failed', 'GET https://queue.fal.run/fal-ai/flux failed'],
    [`opaque ${'a1B2'.repeat(10)} blob`, 'opaque [redacted] blob'],
    ['line one\nline\ttwo\u0000end', 'line one line two end'],
    ['FAL_KEY is not set', 'FAL_KEY is not set'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFailureMessage(input)).toBe(expected);
  });

  it('bounds the length in code points and is idempotent', () => {
    const long = 'é'.repeat(MAX_FAILURE_MESSAGE_LENGTH + 50);
    const once = sanitizeFailureMessage(long);
    expect([...once]).toHaveLength(MAX_FAILURE_MESSAGE_LENGTH);
    expect(once.endsWith('…')).toBe(true);
    expect(sanitizeFailureMessage(once)).toBe(once);
    const secret = 'Bearer abc key=zzz https://x.test/a?b=c';
    expect(sanitizeFailureMessage(sanitizeFailureMessage(secret))).toBe(sanitizeFailureMessage(secret));
  });

  it('taskFailureDetail stores the sanitized message with the kind and category', () => {
    expect(taskFailureDetail({ kind: 'timeout', message: 'slow\nprovider' }, 'transient')).toEqual({
      errorCategory: 'transient',
      errorKind: 'timeout',
      message: 'slow provider',
    });
  });
});

describe('wires', () => {
  it('derives the Redis channel from the payload scope', () => {
    expect(redisChannelFor(notification('decision', FIXTURES.decision))).toBe(`mypes:decision:${CONVERSATION}`);
    expect(redisChannelFor(notification('artifact_published', FIXTURES.artifact_published))).toBe(`mypes:artifact:${CONVERSATION}`);
    expect(redisChannelFor(notification('task_processing', FIXTURES.task_processing))).toBe(
      `mypes:lifecycle:processing:${CONVERSATION}`,
    );
    expect(redisChannelFor(notification('task_dispatch', FIXTURES.task_dispatch))).toBe('mypes:agent_task:dispatch:logo-agent');
  });

  it('reads the scope back only from its own kind of channel', () => {
    expect(redisChannelScope('artifact_published', redisChannelName('artifact_published', CONVERSATION))).toBe(CONVERSATION);
    expect(redisChannelScope('artifact_published', redisChannelName('decision', CONVERSATION))).toBeNull();
    expect(redisChannelScope('decision', 'mypes:decision:')).toBeNull();
  });

  it('gives durable notices a deterministic outbox kind and event id', () => {
    expect(durableEventFor(notification('task_completed', FIXTURES.task_completed))).toEqual({
      outboxKind: 'artifact',
      eventId: `${TASK}:announce_completion`,
    });
    expect(durableEventFor(notification('task_failed', FIXTURES.task_failed))).toEqual({
      outboxKind: 'notice',
      eventId: `${TASK}:announce_failure`,
    });
  });
});
