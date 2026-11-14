/**
 * Integration test for the prompt ledger Postgres store (real local DB).
 * Skipped unless DATABASE_URL (owner) and APP_DATABASE_URL are set. Cleans only rows with its own key prefix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DuplicateRunError, PromptLedger, VersionConflictError } from '../../../lib/prompt-ledger';
import { PostgresLedgerStore } from '../postgres-store';
import { registerCodePrompts } from '../register-code-prompts';

const SUITE = process.env.DATABASE_URL && process.env.APP_DATABASE_URL ? describe : describe.skip;

// Same guard as conversation-trace.integration.test.ts: these tests write throwaway tenants and calls.
function assertDisposableTarget(ownerUrl: string, appUrl: string): void {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const db = owner.pathname.slice(1);
  if (!/(?:_ci|_test)$/.test(db) || app.pathname.slice(1) !== db) {
    throw new Error('Prompt-ledger integration tests require one disposable database ending in _ci or _test');
  }
  if (owner.hostname !== app.hostname || owner.port !== app.port) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must use the same host and port');
  }
  if (owner.username === 'app_user' || app.username !== 'app_user') {
    throw new Error('DATABASE_URL must be the setup owner and APP_DATABASE_URL must be app_user');
  }
}
const guard = () => assertDisposableTarget(process.env.DATABASE_URL!, process.env.APP_DATABASE_URL!);

SUITE('PostgresLedgerStore (integration)', () => {
  const prefix = `itest-${randomUUID().slice(0, 8)}`;
  const key = `${prefix}-prompt`;
  const prodVersion = `${prefix}.v1`;
  let owner: pg.Pool;
  let ledger: PromptLedger;
  let callId: string;
  const tenantId = randomUUID();

  beforeAll(async () => {
    guard();
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    ledger = new PromptLedger({ store: new PostgresLedgerStore(owner as never) });
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `ledger ${prefix}`]);
    const ins = await owner.query(
      `INSERT INTO llm_calls (tenant_id, model, model_revision, prompt_version, input_tokens, output_tokens, latency_ms, provider, purpose)
       VALUES ($1, 'itest-model', 'r', $2, 10, 20, 300, 'openrouter', 'responder') RETURNING id`,
      [tenantId, prodVersion],
    );
    callId = ins.rows[0].id;
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM llm_calls WHERE id = $1`, [callId]);
    await owner.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await owner.query(`DELETE FROM prompt_ledger_eval_runs WHERE key LIKE $1`, [`${prefix}%`]);
    await owner.query(`DELETE FROM prompt_ledger_versions WHERE key LIKE $1`, [`${prefix}%`]);
    await owner.end();
  });

  it('registers versions idempotently', async () => {
    const a = await ledger.registerVersion({ key, version: 'v1', text: 'hello', gitCommit: 'abc' });
    const b = await ledger.registerVersion({ key, version: 'v1', text: 'hello' });
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.gitCommit).toBe('abc');
    await ledger.registerVersion({ key, version: 'v2', text: 'hello 2' });
  });

  it('records eval runs with scores and samples, rejects duplicates, and compares', async () => {
    const base = { key, kind: 'eval' as const, model: 'm', startedAt: new Date().toISOString(), outcome: 'succeeded' as const };
    await ledger.recordRun({ ...base, id: `${prefix}-a1`, version: 'v1', latencyMs: 100, costUsd: 0.01 }, [{ metric: 'q', value: 0.5 }], [{ ref: 's3://x', mediaType: 'image/png' }]);
    await ledger.recordRun({ ...base, id: `${prefix}-b1`, version: 'v2', latencyMs: 50, costUsd: 0.02, outcome: 'failed', errorCategory: 'timeout' }, [{ metric: 'q', value: 0.9 }]);
    await expect(ledger.recordRun({ ...base, id: `${prefix}-a1`, version: 'v1' })).rejects.toBeInstanceOf(DuplicateRunError);

    const cmp = await ledger.compare(key, 'v1', 'v2');
    expect(cmp.a.runs).toBe(1);
    expect(cmp.a.samples).toBe(1);
    expect(cmp.a.scores.q.mean).toBe(0.5);
    expect(cmp.a.costUsd.total).toBeCloseTo(0.01);
    expect(cmp.b.failureRate).toBe(1);
    expect(cmp.delta.scores.q).toBeCloseTo(0.4);
  });


  it('exposes production runs through the store', async () => {
    const store = new PostgresLedgerStore(owner as never);
    const runs = await store.listRuns('responder', prodVersion, 'production');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: callId, kind: 'production', model: 'itest-model', provider: 'openrouter', latencyMs: 300, inputTokens: 10, outputTokens: 20 });
    expect(runs[0].costUsd).toBeUndefined();
    expect(runs[0].outcome).toBeUndefined();
    expect(await store.listScores([callId])).toEqual([]);
    await expect(store.insertRun(runs[0], [], [])).rejects.toThrow();
  });

  it('registers the prompts in code', async () => {
    const out = await registerCodePrompts(ledger, undefined);
    expect(out.map((v) => `${v.key}@${v.version}`)).toEqual(expect.arrayContaining(['extractor@extractor.v5', 'name-agent@name-agent.v1', 'logo-agent@logo-agent.v1']));
    // Platform-level rows are shared and persistent by design; they are not test-owned.
  });

  it('denies app_user every ledger table and function', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      for (const sql of [
        'SELECT * FROM prompt_ledger_versions',
        'SELECT * FROM prompt_ledger_eval_runs',
        'SELECT * FROM prompt_ledger_scores',
        'SELECT * FROM prompt_ledger_samples',
        `INSERT INTO prompt_ledger_versions (key, version, content_hash) VALUES ('x','x','x')`,
        `INSERT INTO prompt_ledger_scores (run_id, metric, value) VALUES ('x','x',1)`,
        `SELECT * FROM app.prompt_ledger_production_runs('responder', 'x')`,
        `SELECT * FROM app.prompt_ledger_production_scores(ARRAY[gen_random_uuid()])`,
        `SELECT app.prompt_ledger_task_approved(gen_random_uuid())`,
      ]) {
        await expect(app.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await app.end();
    }
  });
});

SUITE('PostgresLedgerStore guarantees (integration)', () => {
  const prefix = `itest-${randomUUID().slice(0, 8)}`;
  let owner: pg.Pool;
  let store: PostgresLedgerStore;
  let ledger: PromptLedger;
  const eval_ = (id: string, key: string) => ({
    id, key, version: 'v1', kind: 'eval' as const, model: 'm', startedAt: new Date().toISOString(), outcome: 'succeeded' as const,
  });
  const count = async (table: string, col: string, id: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n;

  beforeAll(() => {
    guard();
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    store = new PostgresLedgerStore(owner as never);
    ledger = new PromptLedger({ store });
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM prompt_ledger_eval_runs WHERE key LIKE $1`, [`${prefix}%`]);
    await owner.query(`DELETE FROM prompt_ledger_versions WHERE key LIKE $1`, [`${prefix}%`]);
    await owner.end();
  });

  it('insertRun is atomic: a failing second score leaves no run, score or sample rows', async () => {
    const key = `${prefix}-atomic`;
    await ledger.registerVersion({ key, version: 'v1', text: 't' });
    const run = eval_(`${prefix}-atomic-run`, key);
    await expect(
      store.insertRun(
        run,
        [{ runId: run.id, metric: 'ok', value: 1 }, { runId: run.id, metric: 'bad', value: Number.NaN }],
        [{ runId: run.id, ref: 's3://x', mediaType: 'image/png' }],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await count('prompt_ledger_eval_runs', 'id', run.id)).toBe(0);
    expect(await count('prompt_ledger_scores', 'run_id', run.id)).toBe(0);
    expect(await count('prompt_ledger_samples', 'run_id', run.id)).toBe(0);
  });

  it('insertRun with a duplicate id throws DuplicateRunError and writes nothing extra', async () => {
    const key = `${prefix}-dup`;
    await ledger.registerVersion({ key, version: 'v1', text: 't' });
    const run = eval_(`${prefix}-dup-run`, key);
    await store.insertRun(run, [{ runId: run.id, metric: 'q', value: 1 }], []);
    await expect(
      store.insertRun(run, [{ runId: run.id, metric: 'q2', value: 2 }], [{ runId: run.id, ref: 'r', mediaType: 'image/png' }]),
    ).rejects.toBeInstanceOf(DuplicateRunError);
    expect(await count('prompt_ledger_eval_runs', 'id', run.id)).toBe(1);
    expect(await count('prompt_ledger_scores', 'run_id', run.id)).toBe(1);
    expect(await count('prompt_ledger_samples', 'run_id', run.id)).toBe(0);
  });

  it('concurrent registerVersion with different content: exactly one wins, the loser gets VersionConflictError', async () => {
    const key = `${prefix}-race`;
    const results = await Promise.allSettled([
      ledger.registerVersion({ key, version: 'v1', text: 'alpha' }),
      ledger.registerVersion({ key, version: 'v1', text: 'beta' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(VersionConflictError);
    expect(await count('prompt_ledger_versions', 'key', key)).toBe(1);
  });

  it('production functions expose metrics only, never tenant/user/conversation/task ids', async () => {
    const runs = await owner.query(`SELECT * FROM app.prompt_ledger_production_runs('responder', $1)`, [`${prefix}.none`]);
    expect(runs.fields.map((f) => f.name)).toEqual([
      'run_id', 'key', 'version', 'model', 'provider', 'occurred_at', 'latency_ms', 'input_tokens', 'output_tokens', 'cost_usd', 'outcome',
    ]);
    const scores = await owner.query(`SELECT * FROM app.prompt_ledger_production_scores(ARRAY[gen_random_uuid()])`);
    expect(scores.fields.map((f) => f.name)).toEqual(['run_id', 'metric', 'value']);
  });
});

SUITE('production approved score (integration, real rows)', () => {
  const prefix = `itest-${randomUUID().slice(0, 8)}`;
  let owner: pg.Pool;
  let store: PostgresLedgerStore;
  let tenantId: string;
  let userId: string;
  let conversationId: string;

  const task = async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO agent_tasks (id, tenant_id, conversation_id, agent_id, agent_card_version, idempotency_key, iteration_root_id, requirements_snapshot)
       VALUES ($1, $2, $3, 'name-agent', 'itest', $4, $1, '{}'::jsonb)`,
      [id, tenantId, conversationId, randomUUID()],
    );
    return id;
  };
  const deliverable = async (taskId: string, kind = 'business_name') => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO deliverables (id, tenant_id, conversation_id, agent_task_id, user_id, kind, content_inline)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
      [id, tenantId, conversationId, taskId, userId, kind],
    );
    return id;
  };
  const approve = (deliverableId: string, kind = 'business_name') =>
    owner.query(
      `INSERT INTO deliverable_approvals (tenant_id, conversation_id, user_id, deliverable_kind, deliverable_id, approved_by)
       VALUES ($1, $2, $3, $4, $5, $3)`,
      [tenantId, conversationId, userId, kind, deliverableId],
    );
  const call = async (taskId: string | null) => {
    const { rows } = await owner.query(
      `INSERT INTO llm_calls (tenant_id, conversation_id, user_id, agent_task_id, model, model_revision, prompt_version, input_tokens, output_tokens, latency_ms, provider, purpose)
       VALUES ($1, $2, $3, $4, 'itest-model', 'r', $5, 1, 1, 1, 'openrouter', 'naming') RETURNING id`,
      [tenantId, conversationId, userId, taskId, `${prefix}.v1`],
    );
    return rows[0].id as string;
  };
  const approvedFor = async (callId: string) =>
    (await store.listScores([callId])).filter((s) => s.metric === 'approved').map((s) => s.value);

  beforeAll(async () => {
    guard();
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    store = new PostgresLedgerStore(owner as never);
    tenantId = randomUUID();
    userId = randomUUID();
    conversationId = randomUUID();
    await owner.query(`INSERT INTO tenants (id, kind, name) VALUES ($1, 'institutional', $2)`, [tenantId, `ledger ${prefix}`]);
    await owner.query(
      `INSERT INTO users (id, tenant_id, workos_user_id, email, role, status) VALUES ($1, $2, $3, $4, 'member', 'active')`,
      [userId, tenantId, `ledger-${prefix}`, `${prefix}@example.invalid`],
    );
    await owner.query(`INSERT INTO conversations (id, tenant_id, user_id) VALUES ($1, $2, $3)`, [conversationId, tenantId, userId]);
  });

  afterAll(async () => {
    // approvals are append-only: they only go away by cascade from the conversation (also clears deliverables and tasks).
    for (const sql of [
      `DELETE FROM llm_calls WHERE tenant_id = $1`,
      `DELETE FROM conversations WHERE tenant_id = $1`,
      `DELETE FROM users WHERE tenant_id = $1`,
    ]) await owner.query(sql, [tenantId]);
    await owner.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await owner.end();
  });

  it('scores 1 when the call task produced the approved deliverable', async () => {
    const t = await task();
    await approve(await deliverable(t));
    expect(await approvedFor(await call(t))).toEqual([1]);
  });

  it('scores 0 when another deliverable of the same conversation and kind was approved instead', async () => {
    const mine = await task();
    await deliverable(mine);
    await approve(await deliverable(await task()));
    expect(await approvedFor(await call(mine))).toEqual([0]);
  });

  it('gives no score when nothing of that kind is approved', async () => {
    const t = await task();
    await deliverable(t, 'tagline');
    expect(await approvedFor(await call(t))).toEqual([]);
  });

  it('gives no score for calls without a task', async () => {
    expect(await approvedFor(await call(null))).toEqual([]);
  });
});
