/**
 * D41 / F23: catalog-driven organization analytics.
 *
 *  - `brief_field_facts`: one row per persisted value of a brief field whose catalog `analytics` is not
 *    `none`, written by the repo at the single place a merged value is saved (`conversations.updateFieldSlot`).
 *    Append-only for app_user (SELECT + column INSERT, no UPDATE/DELETE). Members read only their own
 *    rows; the tenant admin never reads rows, only `app.tenant_analytics`. `raw_canonical` is the canonical
 *    form of the raw text (what an OTRO promotion matches on); `canonical_value` is the dictionary code
 *    (enum), the `,`-joined canonical tags, or `raw_canonical`.
 *  - `dictionary_changes`: global, dated record of every OTRO promotion. Readable by app_user (non-sensitive
 *    metadata shown in both panels); written only by `app.apply_dictionary_promotion`.
 *  - `app.tenant_analytics(p_fields jsonb)`: SECURITY DEFINER, current tenant only, tenant admin only. Returns
 *    ONE jsonb document of aggregates: value counts (only fields whose analytics is category/tags), fill rates,
 *    deliverable funnel, per-conversation turns/alterations, per-user counters. It never returns field values
 *    of `text` fields nor any member's brief content.
 *  - `app.apply_dictionary_promotion(...)`: SECURITY DEFINER, platform actor only. The only writer that
 *    changes historical facts (OTRO -> new category) and it records the change in the same transaction.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE brief_field_facts (
      id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id          uuid        NOT NULL,
      user_id            uuid        NOT NULL,
      brand_id           uuid,
      product_id         uuid,
      conversation_id    uuid        NOT NULL,
      field_name         text        NOT NULL CHECK (field_name ~ '^[a-z][a-z0-9_]{0,63}$'),
      raw_value          text        NOT NULL,
      raw_canonical      text        NOT NULL,
      canonical_value    text        NOT NULL,
      dictionary_version text        CHECK (dictionary_version IS NULL OR dictionary_version ~ '^\\d{4}-\\d{2}-\\d{2}$'),
      catalog_version    text        NOT NULL CHECK (catalog_version ~ '^\\d{4}-\\d{2}-\\d{2}$'),
      recorded_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, conversation_id, user_id) REFERENCES conversations(tenant_id, id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, brand_id, user_id) REFERENCES brands(tenant_id, id, user_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, product_id, user_id) REFERENCES products(tenant_id, id, user_id) ON DELETE RESTRICT
    );
    CREATE INDEX brief_field_facts_latest ON brief_field_facts (tenant_id, conversation_id, field_name, recorded_at DESC);
    CREATE INDEX brief_field_facts_remap ON brief_field_facts (field_name, canonical_value, raw_canonical);

    ALTER TABLE brief_field_facts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE brief_field_facts FORCE  ROW LEVEL SECURITY;
    CREATE POLICY brief_field_facts_read ON brief_field_facts FOR SELECT
      USING (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());
    CREATE POLICY brief_field_facts_insert ON brief_field_facts FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id() AND app.has_active_member());
    GRANT SELECT ON brief_field_facts TO app_user;
    GRANT INSERT (tenant_id, user_id, brand_id, product_id, conversation_id, field_name, raw_value,
                  raw_canonical, canonical_value, dictionary_version, catalog_version)
      ON brief_field_facts TO app_user;

    CREATE TABLE dictionary_changes (
      id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      dictionary_key text        NOT NULL CHECK (dictionary_key ~ '^[a-z][a-z0-9_]{0,63}$'),
      version        text        NOT NULL CHECK (version ~ '^\\d{4}-\\d{2}-\\d{2}$'),
      category       text        NOT NULL CHECK (category <> ''),
      label          text        NOT NULL CHECK (label <> ''),
      rows_remapped  integer     NOT NULL CHECK (rows_remapped >= 0),
      applied_at     timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE dictionary_changes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE dictionary_changes FORCE  ROW LEVEL SECURITY;
    CREATE POLICY dictionary_changes_read ON dictionary_changes FOR SELECT USING (true);
    GRANT SELECT ON dictionary_changes TO app_user;

    CREATE FUNCTION app.tenant_analytics(p_fields jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    DECLARE t uuid := app.current_tenant_id(); result jsonb;
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      WITH catalog AS (
        SELECT f.name, f.analytics FROM jsonb_to_recordset(p_fields) AS f(name text, analytics text)
         WHERE f.analytics IN ('category', 'tags', 'text')
      ),
      latest AS (
        SELECT DISTINCT ON (x.conversation_id, x.field_name) x.conversation_id, x.field_name, x.canonical_value, c.analytics
          FROM public.brief_field_facts x JOIN catalog c ON c.name = x.field_name
         WHERE x.tenant_id = t
         ORDER BY x.conversation_id, x.field_name, x.recorded_at DESC, x.id DESC
      ),
      counts AS (
        SELECT l.field_name, v AS value, count(*) AS n
          FROM latest l
          CROSS JOIN LATERAL unnest(CASE WHEN l.analytics = 'tags' THEN string_to_array(l.canonical_value, ',')
                                         ELSE ARRAY[l.canonical_value] END) AS v
         WHERE l.analytics IN ('category', 'tags') AND v <> ''
         GROUP BY l.field_name, v
      ),
      filled AS (SELECT field_name, count(*) AS n FROM latest GROUP BY field_name),
      tasks AS (
        SELECT a.id AS task_id, a.conversation_id, a.iteration_root_id, a.iteration_trigger, d.kind
          FROM public.agent_tasks a JOIN public.deliverables d ON d.tenant_id = a.tenant_id AND d.agent_task_id = a.id
         WHERE a.tenant_id = t
      ),
      alterations AS (
        SELECT conversation_id, count(DISTINCT task_id) AS n FROM tasks WHERE iteration_trigger IN ('user_reject', 'user_regenerate') GROUP BY conversation_id
      ),
      turns AS (
        SELECT conversation_id, count(*) AS n FROM public.messages WHERE tenant_id = t AND role = 'user' GROUP BY conversation_id
      ),
      per_conversation AS (
        SELECT c.id, c.user_id, coalesce(tu.n, 0) AS turns, coalesce(al.n, 0) AS alterations
          FROM public.conversations c
          LEFT JOIN turns tu ON tu.conversation_id = c.id
          LEFT JOIN alterations al ON al.conversation_id = c.id
         WHERE c.tenant_id = t
      )
      SELECT jsonb_build_object(
        'conversations', (SELECT count(*) FROM per_conversation),
        'turns', (SELECT coalesce(sum(turns), 0) FROM per_conversation),
        'alterations', (SELECT coalesce(sum(alterations), 0) FROM per_conversation),
        'perConversation', jsonb_build_object(
          'avgTurns', (SELECT coalesce(round(avg(turns), 2), 0) FROM per_conversation),
          'avgAlterations', (SELECT coalesce(round(avg(alterations), 2), 0) FROM per_conversation)),
        'fields', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'name', c.name,
            'filledConversations', coalesce((SELECT n FROM filled WHERE field_name = c.name), 0),
            'values', CASE WHEN c.analytics = 'text' THEN '[]'::jsonb ELSE coalesce((
               SELECT jsonb_agg(jsonb_build_object('value', k.value, 'count', k.n) ORDER BY k.n DESC, k.value)
                 FROM counts k WHERE k.field_name = c.name), '[]'::jsonb) END
          )), '[]'::jsonb) FROM catalog c),
        'funnel', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'kind', g.kind, 'generated', g.generated, 'altered', g.altered,
            'approved', coalesce((SELECT count(DISTINCT p.conversation_id) FROM public.deliverable_approvals p
                                   WHERE p.tenant_id = t AND p.deliverable_kind = g.kind), 0)
          ) ORDER BY g.kind), '[]'::jsonb)
          FROM (SELECT kind, count(DISTINCT iteration_root_id) AS generated,
                       count(DISTINCT task_id) FILTER (WHERE iteration_trigger IN ('user_reject', 'user_regenerate')) AS altered
                  FROM tasks GROUP BY kind) g),
        'users', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'userId', u.id, 'email', u.email,
            'conversations', coalesce(s.conversations, 0), 'turns', coalesce(s.turns, 0), 'alterations', coalesce(s.alterations, 0)
          ) ORDER BY u.email), '[]'::jsonb)
          FROM public.users u
          LEFT JOIN (SELECT user_id, count(*) AS conversations, sum(turns) AS turns, sum(alterations) AS alterations
                       FROM per_conversation GROUP BY user_id) s ON s.user_id = u.id
         WHERE u.tenant_id = t),
        'dictionaryChanges', (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'dictionaryKey', d.dictionary_key, 'version', d.version, 'category', d.category,
            'label', d.label, 'appliedAt', d.applied_at) ORDER BY d.applied_at DESC), '[]'::jsonb)
          FROM public.dictionary_changes d)
      ) INTO result;
      RETURN result;
    END $fn$;
    REVOKE ALL ON FUNCTION app.tenant_analytics(jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.tenant_analytics(jsonb) TO app_user;

    CREATE FUNCTION app.apply_dictionary_promotion(
      p_key text, p_version text, p_category text, p_label text, p_fields text[], p_texts text[])
    RETURNS integer
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    DECLARE remapped integer;
    BEGIN
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      UPDATE public.brief_field_facts
         SET canonical_value = p_category, dictionary_version = p_version
       WHERE field_name = ANY(p_fields) AND canonical_value = 'OTRO' AND raw_canonical = ANY(p_texts);
      GET DIAGNOSTICS remapped = ROW_COUNT;
      INSERT INTO public.dictionary_changes (dictionary_key, version, category, label, rows_remapped)
        VALUES (p_key, p_version, p_category, p_label, remapped);
      RETURN remapped;
    END $fn$;
    REVOKE ALL ON FUNCTION app.apply_dictionary_promotion(text, text, text, text, text[], text[]) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.apply_dictionary_promotion(text, text, text, text, text[], text[]) TO app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS app.apply_dictionary_promotion(text, text, text, text, text[], text[]);
    DROP FUNCTION IF EXISTS app.tenant_analytics(jsonb);
    DROP TABLE IF EXISTS dictionary_changes;
    DROP TABLE IF EXISTS brief_field_facts;
  `);
};
