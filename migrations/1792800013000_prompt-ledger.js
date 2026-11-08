/**
 * Prompt ledger (step 2): Postgres store for prompt versions and eval runs.
 *
 * GLOBAL tables on purpose (no tenant_id, no RLS): they hold platform-level prompt metadata
 * and synthetic eval data, never tenant content. They are developer tooling (evals, CLI) and
 * the runtime role `app_user` gets NO access: REVOKE ALL on tables and functions.
 *
 * Production runs are NOT copied here (no second write path). `app.prompt_ledger_production_runs`
 * (SECURITY DEFINER, row_security off, same posture as `app.platform_monthly_metrics`) reads
 * the existing `llm_calls` rows and returns metrics only: no tenant/user/conversation/task ids
 * and no content. Mapping: run id = llm_calls.id, key = purpose, version = prompt_version.
 *  - cost_usd is always NULL: llm_calls has no cost and no table links a cost to one call
 *    (usage_reservations link to attempts/tasks, not to llm_calls rows).
 *  - outcome is always NULL (unknown): withLlmLogging only inserts after a completed call, so
 *    failures never reach llm_calls and 'succeeded' would be a false 0% failure rate.
 *  - `approved` score comes from deliverable_approvals via the call's agent task, only for
 *    task-backed calls (naming): 1 if a deliverable of the task was approved, 0 if another
 *    deliverable of the same conversation+kind was approved instead, otherwise no score.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE prompt_ledger_versions (
      key          text        NOT NULL CHECK (btrim(key) <> ''),
      version      text        NOT NULL CHECK (btrim(version) <> ''),
      content_hash text        NOT NULL CHECK (btrim(content_hash) <> ''),
      git_commit   text        CHECK (git_commit IS NULL OR btrim(git_commit) <> ''),
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (key, version)
    );

    CREATE TABLE prompt_ledger_eval_runs (
      id             text             PRIMARY KEY CHECK (btrim(id) <> ''),
      key            text             NOT NULL,
      version        text             NOT NULL,
      model          text             NOT NULL CHECK (btrim(model) <> ''),
      provider       text             CHECK (provider IS NULL OR btrim(provider) <> ''),
      started_at     timestamptz      NOT NULL,
      latency_ms     double precision CHECK (latency_ms >= 0),
      input_tokens   double precision CHECK (input_tokens >= 0),
      output_tokens  double precision CHECK (output_tokens >= 0),
      cost_usd       numeric          CHECK (cost_usd >= 0),
      outcome        text             NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
      error_category text             CHECK (error_category IS NULL OR btrim(error_category) <> ''),
      experiment_id  text             CHECK (experiment_id IS NULL OR btrim(experiment_id) <> ''),
      FOREIGN KEY (key, version) REFERENCES prompt_ledger_versions (key, version)
    );
    CREATE INDEX prompt_ledger_eval_runs_version_idx ON prompt_ledger_eval_runs (key, version, started_at);

    CREATE TABLE prompt_ledger_scores (
      run_id text             NOT NULL REFERENCES prompt_ledger_eval_runs (id) ON DELETE CASCADE,
      metric text             NOT NULL CHECK (btrim(metric) <> ''),
      value  double precision NOT NULL CHECK (value <> 'NaN' AND value NOT IN ('Infinity', '-Infinity'))
    );
    CREATE INDEX prompt_ledger_scores_run_idx ON prompt_ledger_scores (run_id);

    CREATE TABLE prompt_ledger_samples (
      run_id     text NOT NULL REFERENCES prompt_ledger_eval_runs (id) ON DELETE CASCADE,
      ref        text NOT NULL CHECK (btrim(ref) <> ''),
      media_type text NOT NULL CHECK (btrim(media_type) <> '')
    );
    CREATE INDEX prompt_ledger_samples_run_idx ON prompt_ledger_samples (run_id);

    REVOKE ALL ON prompt_ledger_versions, prompt_ledger_eval_runs, prompt_ledger_scores, prompt_ledger_samples
      FROM PUBLIC, app_user;

    CREATE FUNCTION app.prompt_ledger_production_runs(p_key text, p_version text)
    RETURNS TABLE (run_id text, key text, version text, model text, provider text, occurred_at timestamptz,
                   latency_ms integer, input_tokens integer, output_tokens integer, cost_usd numeric, outcome text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
      SELECT l.id::text, l.purpose, l.prompt_version, l.model, l.provider, l.occurred_at,
             l.latency_ms, l.input_tokens, l.output_tokens, NULL::numeric, NULL::text
        FROM public.llm_calls l
       WHERE l.purpose = p_key AND l.prompt_version = p_version
       ORDER BY l.occurred_at, l.id
    $fn$;

    CREATE FUNCTION app.prompt_ledger_task_approved(p_task uuid)
    RETURNS smallint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM public.deliverables d
                       JOIN public.deliverable_approvals a ON a.tenant_id = d.tenant_id AND a.deliverable_id = d.id
                      WHERE d.agent_task_id = p_task) THEN 1
        WHEN EXISTS (SELECT 1 FROM public.deliverables d
                       JOIN public.deliverable_approvals a ON a.tenant_id = d.tenant_id
                        AND a.conversation_id = d.conversation_id AND a.deliverable_kind = d.kind
                      WHERE d.agent_task_id = p_task) THEN 0
      END::smallint
    $fn$;

    CREATE FUNCTION app.prompt_ledger_production_scores(p_run_ids uuid[])
    RETURNS TABLE (run_id text, metric text, value double precision)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
      SELECT l.id::text, 'approved'::text, a.v::double precision
        FROM public.llm_calls l
        CROSS JOIN LATERAL (SELECT app.prompt_ledger_task_approved(l.agent_task_id) AS v) a
       WHERE l.id = ANY (p_run_ids) AND l.agent_task_id IS NOT NULL AND a.v IS NOT NULL
    $fn$;

    REVOKE ALL ON FUNCTION app.prompt_ledger_production_runs(text, text) FROM PUBLIC, app_user;
    REVOKE ALL ON FUNCTION app.prompt_ledger_task_approved(uuid) FROM PUBLIC, app_user;
    REVOKE ALL ON FUNCTION app.prompt_ledger_production_scores(uuid[]) FROM PUBLIC, app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS app.prompt_ledger_production_scores(uuid[]);
    DROP FUNCTION IF EXISTS app.prompt_ledger_task_approved(uuid);
    DROP FUNCTION IF EXISTS app.prompt_ledger_production_runs(text, text);
    DROP TABLE IF EXISTS prompt_ledger_samples;
    DROP TABLE IF EXISTS prompt_ledger_scores;
    DROP TABLE IF EXISTS prompt_ledger_eval_runs;
    DROP TABLE IF EXISTS prompt_ledger_versions;
  `);
};
