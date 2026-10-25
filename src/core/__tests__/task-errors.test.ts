/**
 * KAN-58: the agent-agnostic error classifier maps a failed task's typed
 * `error.kind` onto the persisted `error_category` enum. Pure, no fakes needed.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyTaskError,
  DEFAULT_TASK_ERROR_CATEGORY,
  TASK_ERROR_KINDS,
  TaskError,
  taskErrorFromThrown,
} from '../task-errors';

describe('classifyTaskError', () => {
  it('maps a content-policy rejection to content_policy', () => {
    expect(classifyTaskError({ kind: 'content_policy' })).toBe('content_policy');
  });

  it.each(['rate_limited', 'timeout', 'provider_unavailable'])(
    'maps the retryable kind %s to transient',
    (kind) => {
      expect(classifyTaskError({ kind })).toBe('transient');
    },
  );

  it.each(['config_missing', 'provider_rejected', 'invalid_output', 'not_implemented', 'handler_threw'])(
    'maps the non-retryable kind %s to permanent_bug',
    (kind) => {
      expect(classifyTaskError({ kind })).toBe('permanent_bug');
    },
  );

  it.each(['', 'unknown', 'HANDLER_THREW', 'toString', 'constructor'])(
    'defaults the unknown kind %j to permanent_bug so it is never retried automatically',
    (kind) => {
      expect(DEFAULT_TASK_ERROR_CATEGORY).toBe('permanent_bug');
      expect(classifyTaskError({ kind })).toBe('permanent_bug');
    },
  );

  it('classifies every declared kind into a valid enum value', () => {
    for (const kind of TASK_ERROR_KINDS) {
      expect(['transient', 'content_policy', 'permanent_bug']).toContain(classifyTaskError({ kind }));
    }
  });
});

describe('taskErrorFromThrown', () => {
  it('keeps the typed kind of a TaskError', () => {
    expect(taskErrorFromThrown(new TaskError('rate_limited', 'slow down'))).toEqual({
      kind: 'rate_limited',
      message: 'slow down',
    });
  });

  it('keeps a known kind property on any thrown object', () => {
    const err = Object.assign(new Error('blocked'), { kind: 'content_policy' });
    expect(taskErrorFromThrown(err)).toEqual({ kind: 'content_policy', message: 'blocked' });
  });

  it('falls back to handler_threw for untyped or unknown-kind errors', () => {
    expect(taskErrorFromThrown(new Error('boom'))).toEqual({ kind: 'handler_threw', message: 'boom' });
    expect(taskErrorFromThrown(Object.assign(new Error('x'), { kind: 'made_up' }))).toEqual({
      kind: 'handler_threw',
      message: 'x',
    });
    expect(taskErrorFromThrown('plain string')).toEqual({ kind: 'handler_threw', message: 'plain string' });
  });
});
