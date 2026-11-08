import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_tenant: unknown, _user: unknown, work: (tx: { query: typeof mocked.query }) => unknown) =>
    work({ query: mocked.query }),
  withTenantAdminTransaction: async (_tenant: unknown, work: (tx: { query: typeof mocked.query }) => unknown) =>
    work({ query: mocked.query }),
}));

import type { ConversationId, TaskId } from '../../core/contracts';
import { parseNotification } from '../../core/contracts/notifications';
import { aiEventsRepo, aiTurnsRepo } from '../ai-turns';
import { STALE_IN_PROGRESS_TASK_MS } from '../../core/task-errors';

const TENANT = 'tenant-a';
const USER = 'user-a';
const CONVERSATION = 'conversation-a' as ConversationId;
const TASK = 'task-a' as TaskId;
const LOGO_ARTIFACT = {
  kind: 'image',
  url: 'https://example.invalid/synthetic.png',
  metadata: { provider: 'fal', model: 'synthetic-model', prompt: 'logo sintético', purpose: 'logo' },
};

type Call = { sql: string; params: unknown[] };

function calls(): Call[] {
  return mocked.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params: (params ?? []) as unknown[] }));
}

function outboxPayload(): unknown {
  const insert = calls().find((call) => call.sql.includes('INSERT INTO ai_turn_events'));
  expect(insert).toBeDefined();
  return JSON.parse(String(insert!.params[6]));
}

describe('aiTurnsRepo task settlement artifact parity (KAN-81)', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('stores the artifact kind and metadata of a URL deliverable next to the live notice', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_tasks t') && sql.includes('FOR UPDATE')) {
        return { rows: [{ agent_id: 'logo-agent', status: 'in_progress' }] };
      }
      if (sql.includes('INSERT INTO deliverables')) return { rows: [{ id: 'deliverable-a' }] };
      return { rows: [], rowCount: 1 };
    });

    await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
      conversationId: CONVERSATION,
      taskId: TASK,
      state: 'completed',
      deliverableKind: 'logo',
      artifacts: [LOGO_ARTIFACT],
    });

    const insert = calls().find((call) => call.sql.includes('INSERT INTO deliverables'))!;
    expect(insert.sql).toMatch(/content_inline,\s*artifact_kind,\s*artifact_metadata,\s*storage_key\)/);
    // A URL deliverable keeps content_inline null (readers treat it as inline content).
    expect(insert.params[5]).toBe(LOGO_ARTIFACT.url);
    expect(insert.params[6]).toBeNull();
    expect(insert.params[7]).toBe('image');
    expect(JSON.parse(String(insert.params[8]))).toEqual(LOGO_ARTIFACT.metadata);

    expect(parseNotification(outboxPayload(), ['task_completed'])).toMatchObject({
      ok: true,
      notification: { artifacts: [{ kind: 'image', url: LOGO_ARTIFACT.url, inline: null, metadata: LOGO_ARTIFACT.metadata }] },
    });
  });

  it('stores an empty metadata object when the artifact has none, as the live notice does', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_tasks t') && sql.includes('FOR UPDATE')) {
        return { rows: [{ agent_id: 'logo-agent', status: 'in_progress' }] };
      }
      if (sql.includes('INSERT INTO deliverables')) return { rows: [{ id: 'deliverable-a' }] };
      return { rows: [], rowCount: 1 };
    });

    await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
      conversationId: CONVERSATION,
      taskId: TASK,
      state: 'completed',
      deliverableKind: 'logo',
      artifacts: [{ kind: 'image', url: LOGO_ARTIFACT.url }],
    });

    const insert = calls().find((call) => call.sql.includes('INSERT INTO deliverables'))!;
    expect(insert.params[7]).toBe('image');
    expect(JSON.parse(String(insert.params[8]))).toEqual({});
    expect((outboxPayload() as { artifacts: unknown[] }).artifacts).toEqual([
      { kind: 'image', url: LOGO_ARTIFACT.url, inline: null, metadata: {} },
    ]);
  });

  it('projects the stored artifact facts first and falls back to content_inline, then the deliverable kind', async () => {
    mocked.query.mockResolvedValue({ rows: [] });

    await aiTurnsRepo({ id: TENANT }, { id: USER }).enqueueSettledTaskEvents({ conversationId: CONVERSATION, taskId: TASK });

    const projection = calls()[0].sql;
    expect(projection).toContain(`'kind', COALESCE(d.artifact_kind, d.content_inline->>'kind', d.kind::text)`);
    expect(projection).toContain(`'metadata', COALESCE(d.artifact_metadata, d.content_inline->'metadata', '{}'::jsonb)`);
  });

  it('rebuilds a completion notice equal to the live one from the stored artifact facts', async () => {
    // Live settlement: capture what is stored and what is announced.
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_tasks t') && sql.includes('FOR UPDATE')) {
        return { rows: [{ agent_id: 'logo-agent', status: 'in_progress' }] };
      }
      if (sql.includes('INSERT INTO deliverables')) return { rows: [{ id: 'deliverable-a' }] };
      return { rows: [], rowCount: 1 };
    });
    await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
      conversationId: CONVERSATION,
      taskId: TASK,
      state: 'completed',
      deliverableKind: 'logo',
      artifacts: [LOGO_ARTIFACT],
    });
    const live = outboxPayload();
    const stored = calls().find((call) => call.sql.includes('INSERT INTO deliverables'))!.params;

    // Rebuild: the projection returns the stored columns (artifact_kind/artifact_metadata set).
    mocked.query.mockReset();
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_tasks t')) {
        return {
          rows: [{
            taskId: TASK,
            agentId: 'logo-agent',
            status: 'completed',
            errorCategory: null,
            error: null,
            deliverableIds: ['deliverable-a'],
            artifacts: [{ kind: stored[7], url: stored[5], inline: null, metadata: JSON.parse(String(stored[8])) }],
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    await aiTurnsRepo({ id: TENANT }, { id: USER }).enqueueSettledTaskEvents({ conversationId: CONVERSATION, taskId: TASK });

    expect(outboxPayload()).toEqual(live);
  });

  describe('stored images (KAN-52)', () => {
    const KEY = `tenants/${TENANT}/conversations/${CONVERSATION}/tasks/${TASK}/0.png`;
    const STORED_ARTIFACT = { ...LOGO_ARTIFACT, storageKey: KEY };

    function settleMock() {
      mocked.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agent_tasks t') && sql.includes('FOR UPDATE')) {
          return { rows: [{ agent_id: 'logo-agent', status: 'in_progress' }] };
        }
        if (sql.includes('INSERT INTO deliverables')) return { rows: [{ id: 'deliverable-a' }] };
        return { rows: [], rowCount: 1 };
      });
    }

    it('stores the object key, keeps the provider URL for provenance, and announces only the asset route', async () => {
      settleMock();
      await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
        conversationId: CONVERSATION, taskId: TASK, state: 'completed', deliverableKind: 'logo', artifacts: [STORED_ARTIFACT],
      });

      const insert = calls().find((call) => call.sql.includes('INSERT INTO deliverables'))!;
      expect(insert.params[5]).toBe(LOGO_ARTIFACT.url);
      expect(insert.params[9]).toBe(KEY);
      const live = outboxPayload() as { artifacts: Array<{ url: string }> };
      expect(live.artifacts).toEqual([{ kind: 'image', url: '/api/assets/deliverable-a', inline: null, metadata: LOGO_ARTIFACT.metadata }]);
      const serialized = JSON.stringify(live);
      expect(serialized).not.toContain(LOGO_ARTIFACT.url);
      expect(serialized).not.toContain(KEY);
    });

    it('projects the deliverable id and storage key for the shared URL rule', async () => {
      mocked.query.mockResolvedValue({ rows: [] });
      await aiTurnsRepo({ id: TENANT }, { id: USER }).enqueueSettledTaskEvents({ conversationId: CONVERSATION, taskId: TASK });
      const projection = calls()[0].sql;
      expect(projection).toContain(`'deliverableId', d.id`);
      expect(projection).toContain(`'storageKey', d.storage_key`);
    });

    it('rebuilds a notice equal to the live one for a stored image', async () => {
      settleMock();
      await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
        conversationId: CONVERSATION, taskId: TASK, state: 'completed', deliverableKind: 'logo', artifacts: [STORED_ARTIFACT],
      });
      const live = outboxPayload();
      const stored = calls().find((call) => call.sql.includes('INSERT INTO deliverables'))!.params;

      mocked.query.mockReset();
      mocked.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agent_tasks t')) {
          return {
            rows: [{
              taskId: TASK, agentId: 'logo-agent', status: 'completed', errorCategory: null, error: null,
              deliverableIds: ['deliverable-a'],
              artifacts: [{
                deliverableId: 'deliverable-a', storageKey: stored[9],
                kind: stored[7], url: stored[5], inline: null, metadata: JSON.parse(String(stored[8])),
              }],
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      });
      await aiTurnsRepo({ id: TENANT }, { id: USER }).enqueueSettledTaskEvents({ conversationId: CONVERSATION, taskId: TASK });

      expect(outboxPayload()).toEqual(live);
    });

    it('re-announces a stored image of an already-settled task through the asset route', async () => {
      mocked.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agent_tasks t') && sql.includes('FOR UPDATE')) {
          return { rows: [{ agent_id: 'logo-agent', status: 'completed' }] };
        }
        if (sql.includes('SELECT id, storage_key')) return { rows: [{ id: 'deliverable-a', storage_key: KEY }] };
        return { rows: [], rowCount: 0 };
      });
      const settled = await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
        conversationId: CONVERSATION, taskId: TASK, state: 'completed', deliverableKind: 'logo', artifacts: [STORED_ARTIFACT],
      });
      expect(settled.deliverableIds).toEqual(['deliverable-a']);
      expect(calls().some((call) => call.sql.includes('INSERT INTO deliverables'))).toBe(false);
      expect((outboxPayload() as { artifacts: Array<{ url: string }> }).artifacts[0].url).toBe('/api/assets/deliverable-a');
    });
  });
});

describe('stale in_progress sweep and late settlement', () => {
  const MIN = 60_000;
  /** Fake the sweep's conditional UPDATE: only rows older than the `$2` threshold come back. */
  function fakeSweep(ageMs: number) {
    mocked.query.mockReset();
    mocked.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('UPDATE agent_tasks t') && sql.includes('SKIP LOCKED')) {
        return ageMs > Number(params[1])
          ? { rows: [{ id: TASK, conversation_id: CONVERSATION, agent_id: 'logo-agent', user_id: USER }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
  }

  it('fails a task stuck 11 minutes with kind timeout / transient and enqueues the task_failed notice', async () => {
    fakeSweep(11 * MIN);
    expect(await aiEventsRepo({ id: TENANT }).failStaleInProgress()).toBe(1);
    const sweep = calls().find((call) => call.sql.includes('SKIP LOCKED'))!;
    expect(sweep.params[1]).toBe(STALE_IN_PROGRESS_TASK_MS);
    expect(sweep.params[2]).toBe('transient');
    expect(JSON.parse(String(sweep.params[3])).kind).toBe('timeout');
    const notice = parseNotification(outboxPayload());
    expect(notice).toMatchObject({
      ok: true,
      notification: { kind: 'task_failed', taskId: TASK, detail: { errorKind: 'timeout', errorCategory: 'transient' } },
    });
  });

  it('leaves a task at 9 minutes untouched', async () => {
    fakeSweep(9 * MIN);
    expect(await aiEventsRepo({ id: TENANT }).failStaleInProgress()).toBe(0);
    expect(calls().some((call) => call.sql.includes('INSERT INTO ai_turn_events'))).toBe(false);
  });

  it('drops a late completed settlement for a task the sweep already failed', async () => {
    mocked.query.mockReset();
    mocked.query.mockImplementation(async (sql: string) =>
      sql.includes('FOR UPDATE') ? { rows: [{ agent_id: 'logo-agent', status: 'failed' }] } : { rows: [], rowCount: 1 });
    const settled = await aiTurnsRepo({ id: TENANT }, { id: USER }).settleTaskAndEnqueue({
      conversationId: CONVERSATION, taskId: TASK, state: 'completed', deliverableKind: 'logo', artifacts: [LOGO_ARTIFACT],
    });
    expect(settled).toEqual({ deliverableIds: [], applied: false });
    expect(calls().some((call) => /INSERT INTO (deliverables|ai_turn_events)|UPDATE agent_tasks/.test(call.sql))).toBe(false);
  });
});

describe('aiEventsRepo.reconcileSettledTasks sweep', () => {
  beforeEach(() => {
    mocked.query.mockReset();
  });

  it('selects only settled tasks that lack their durable notice, so the limit never stalls on repaired rows', async () => {
    mocked.query.mockImplementation(async (sql: string) => ({ rows: String(sql).includes('DISTINCT') ? [{ userId: USER }] : [] }));

    await aiEventsRepo({ id: TENANT } as never).reconcileSettledTasks({ limit: 1 });

    const select = calls().find((call) => call.sql.includes('LEFT JOIN ai_turn_events e'))!;
    expect(select.sql).toContain('e.id IS NULL');
    expect(select.sql).toContain('c.user_id=$2');
    expect(select.params).toEqual([TENANT, USER, 1, 'announce_completion', 'announce_failure']);
    // events are only visible once the owner is bound (RLS), so the owner is set before the query
    expect(calls().findIndex((call) => call.sql.includes("set_config('app.user_id'"))).toBeLessThan(calls().findIndex((call) => call.sql.includes('LEFT JOIN ai_turn_events e')));
  });
});
