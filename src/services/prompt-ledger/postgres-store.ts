import { DuplicateRunError } from '../../lib/prompt-ledger';
import type { Feedback, LedgerStore, PromptVersion, Run, RunKind, Sample, Score } from '../../lib/prompt-ledger';
import { loggerFor } from '../logger';

const log = loggerFor('service.prompt-ledger');

/** Minimal surface of pg.Pool / pg.PoolClient, so tests can inject a fake. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
/** insertRun needs a dedicated connection for its transaction. */
export type TransactionalQueryable = Queryable & { connect(): Promise<Queryable & { release(err?: Error | boolean): void }> };

const UNIQUE_VIOLATION = '23505';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string) => new Date(d).toISOString();
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

function toVersion(r: any): PromptVersion {
  const v: PromptVersion = { key: r.key, version: r.version, contentHash: r.content_hash, createdAt: iso(r.created_at) };
  if (r.git_commit !== null) v.gitCommit = r.git_commit;
  return v;
}

function toRun(r: any, kind: RunKind): Run {
  const run: Run = {
    id: r.run_id, key: r.key, version: r.version, kind, model: r.model,
    startedAt: iso(r.started_at),
  };
  if (r.outcome !== null) run.outcome = r.outcome;
  const optional: Partial<Run> = {
    provider: r.provider ?? undefined, latencyMs: num(r.latency_ms), inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens), costUsd: num(r.cost_usd),
    errorCategory: r.error_category ?? undefined, experimentId: r.experiment_id ?? undefined,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (run as any)[k] = v;
  return run;
}

// Ledger keys per agent; llm_calls.purpose stays 'naming' for all of them (versions keep them apart).
const PRODUCTION_PURPOSE: Record<string, string> = { 'name-agent': 'naming', 'tagline-agent': 'naming', 'social-agent': 'naming', 'logo-agent': 'naming' };

export class PostgresLedgerStore implements LedgerStore {
  constructor(private readonly db: TransactionalQueryable) {}

  async insertVersionIfAbsent(v: PromptVersion): Promise<PromptVersion> {
    await this.db.query(
      `INSERT INTO prompt_ledger_versions (key, version, content_hash, git_commit, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key, version) DO NOTHING`,
      [v.key, v.version, v.contentHash, v.gitCommit ?? null, v.createdAt],
    );
    return (await this.getVersion(v.key, v.version))!;
  }

  async getVersion(key: string, version: string): Promise<PromptVersion | null> {
    const { rows } = await this.db.query(`SELECT * FROM prompt_ledger_versions WHERE key = $1 AND version = $2`, [key, version]);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async listVersions(key: string): Promise<PromptVersion[]> {
    const { rows } = await this.db.query(`SELECT * FROM prompt_ledger_versions WHERE key = $1 ORDER BY created_at, version`, [key]);
    return rows.map(toVersion);
  }

  async insertRun(run: Run, scores: Score[], samples: Sample[]): Promise<void> {
    // No second write path: production runs already live in llm_calls.
    if (run.kind !== 'eval') throw new Error('Only eval runs can be written; production runs are read from llm_calls');
    const client = await this.db.connect();
    // A client whose ROLLBACK failed is in an unknown state: destroy it instead of returning it to the pool.
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO prompt_ledger_eval_runs (id, key, version, model, provider, started_at, latency_ms,
           input_tokens, output_tokens, cost_usd, outcome, error_category, experiment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [run.id, run.key, run.version, run.model, run.provider ?? null, run.startedAt, run.latencyMs ?? null,
          run.inputTokens ?? null, run.outputTokens ?? null, run.costUsd ?? null, run.outcome ?? null,
          run.errorCategory ?? null, run.experimentId ?? null],
      );
      for (const s of scores) {
        await client.query(`INSERT INTO prompt_ledger_scores (run_id, metric, value) VALUES ($1,$2,$3)`, [s.runId, s.metric, s.value]);
      }
      for (const s of samples) {
        await client.query(`INSERT INTO prompt_ledger_samples (run_id, ref, media_type) VALUES ($1,$2,$3)`, [s.runId, s.ref, s.mediaType]);
      }
      await client.query('COMMIT');
      log.debug({ runId: run.id, key: run.key, version: run.version }, 'prompt-ledger.run.recorded');
    } catch (err) {
      await client.query('ROLLBACK').catch((e: Error) => { broken = e; });
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new DuplicateRunError(run.id);
      log.error({ err, runId: run.id }, 'prompt-ledger.run.failed');
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async upsertFeedback(_fb: Feedback): Promise<void> {
    throw new Error('Feedback is written only by the app through repos (deliverableFeedback), never through the ledger');
  }

  async listFeedback(key: string, version: string): Promise<Feedback[]> {
    const { rows } = await this.db.query(`SELECT * FROM app.prompt_ledger_feedback($1)`, [version]);
    return rows.map((r) => ({ subjectId: r.subject_id, raterId: r.rater_hash, key, version, value: r.value, at: iso(r.updated_at) }));
  }

  async listRuns(key: string, version: string, kind?: RunKind): Promise<Run[]> {
    const runs: Run[] = [];
    if (kind !== 'production') {
      const { rows } = await this.db.query(
        `SELECT *, id AS run_id FROM prompt_ledger_eval_runs WHERE key = $1 AND version = $2 ORDER BY started_at, id`,
        [key, version],
      );
      runs.push(...rows.map((r) => toRun(r, 'eval')));
    }
    if (kind !== 'eval') {
      const { rows } = await this.db.query(
        `SELECT *, occurred_at AS started_at FROM app.prompt_ledger_production_runs($1, $2)`,
        [PRODUCTION_PURPOSE[key] ?? key, version],
      );
      runs.push(...rows.map((r) => toRun(r, 'production')));
    }
    return runs;
  }

  async listScores(runIds: string[]): Promise<Score[]> {
    if (runIds.length === 0) return [];
    const { rows } = await this.db.query(`SELECT run_id, metric, value FROM prompt_ledger_scores WHERE run_id = ANY($1::text[])`, [runIds]);
    const uuids = runIds.filter((id) => UUID.test(id));
    const prod = uuids.length
      ? (await this.db.query(`SELECT run_id, metric, value FROM app.prompt_ledger_production_scores($1::uuid[])`, [uuids])).rows
      : [];
    return [...rows, ...prod].map((r) => ({ runId: r.run_id, metric: r.metric, value: Number(r.value) }));
  }

  async countSamples(runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM prompt_ledger_samples WHERE run_id = ANY($1::text[])`, [runIds]);
    return rows[0].n;
  }
}
