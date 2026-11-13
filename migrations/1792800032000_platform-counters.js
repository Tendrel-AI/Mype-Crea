/**
 * KAN-104 (F24, D37/D38/D41): platform-console read/write functions. All SECURITY DEFINER and gated by
 * `app.is_platform_actor()` (an active superadmin set by `assertActivePlatformActor` in the same transaction).
 *
 *  - `app.set_platform_limit_default(key, value)`: the only writer of `platform_limit_defaults`; returns the
 *    previous value (NULL for a new key). Existing tenant profiles already hold their copied values, so they do not change.
 *  - `app.platform_otro_texts(fields, top_n)`: most frequent raw texts that still sit in `OTRO`, across tenants
 *    (text, count, last seen; never user, tenant or conversation ids).
 *  - `app.platform_tenant_counters(tenant)`: ONE jsonb of aggregates for one tenant (never brief content or per-user data).
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION app.set_platform_limit_default(p_key text, p_value int)
    RETURNS int
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    DECLARE v_before int;
    BEGIN
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      IF p_value IS NULL OR p_value NOT BETWEEN 0 AND 1000 THEN
        RAISE EXCEPTION 'limit value must be between 0 and 1000';
      END IF;
      SELECT value INTO v_before FROM public.platform_limit_defaults WHERE limit_key = p_key;
      INSERT INTO public.platform_limit_defaults (limit_key, value) VALUES (p_key, p_value)
      ON CONFLICT (limit_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
      RETURN v_before;
    END $fn$;
    REVOKE ALL ON FUNCTION app.set_platform_limit_default(text, int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.set_platform_limit_default(text, int) TO app_user;

    CREATE FUNCTION app.platform_otro_texts(p_fields text[], p_top int DEFAULT 50)
    RETURNS TABLE (field_name text, raw_canonical text, n bigint, last_seen timestamptz)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    BEGIN
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      RETURN QUERY
        SELECT r.field_name, r.raw_canonical, r.n, r.last_seen FROM (
          SELECT f.field_name, f.raw_canonical, count(*) AS n, max(f.recorded_at) AS last_seen,
                 row_number() OVER (PARTITION BY f.field_name ORDER BY count(*) DESC, f.raw_canonical) AS rk
            FROM public.brief_field_facts f
           WHERE f.field_name = ANY(p_fields) AND f.canonical_value = 'OTRO'
           GROUP BY f.field_name, f.raw_canonical
        ) r WHERE r.rk <= least(greatest(p_top, 1), 200)
        ORDER BY r.field_name, r.rk;
    END $fn$;
    REVOKE ALL ON FUNCTION app.platform_otro_texts(text[], int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_otro_texts(text[], int) TO app_user;

    CREATE FUNCTION app.platform_tenant_counters(p_tenant uuid)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    DECLARE result jsonb;
    BEGIN
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      WITH tasks AS (
        SELECT a.id AS task_id, a.iteration_root_id, a.iteration_trigger, d.kind
          FROM public.agent_tasks a JOIN public.deliverables d ON d.tenant_id = a.tenant_id AND d.agent_task_id = a.id
         WHERE a.tenant_id = p_tenant
      ),
      conv AS (SELECT count(*) AS n FROM public.conversations WHERE tenant_id = p_tenant),
      turns AS (SELECT count(*) AS n FROM public.messages WHERE tenant_id = p_tenant AND role = 'user'),
      alts AS (SELECT count(DISTINCT task_id) AS n FROM tasks WHERE iteration_trigger IN ('user_reject', 'user_regenerate')),
      gen AS (SELECT count(DISTINCT iteration_root_id) AS n FROM tasks)
      SELECT jsonb_build_object(
        'brands', (SELECT count(*) FROM public.brands WHERE tenant_id = p_tenant),
        'products', (SELECT count(*) FROM public.products WHERE tenant_id = p_tenant),
        'conversations', (SELECT n FROM conv),
        'turns', (SELECT n FROM turns),
        'alterations', (SELECT n FROM alts),
        'avgTurnsPerConversation', (SELECT CASE WHEN conv.n = 0 THEN 0 ELSE round(turns.n::numeric / conv.n, 2) END FROM conv, turns),
        'avgAlterationsPerDeliverable', (SELECT CASE WHEN gen.n = 0 THEN 0 ELSE round(alts.n::numeric / gen.n, 2) END FROM gen, alts),
        'deliverablesByKind', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', g.kind, 'generated', g.generated) ORDER BY g.kind), '[]'::jsonb)
          FROM (SELECT kind::text AS kind, count(DISTINCT iteration_root_id) AS generated FROM tasks GROUP BY kind) g)
      ) INTO result;
      RETURN result;
    END $fn$;
    REVOKE ALL ON FUNCTION app.platform_tenant_counters(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_tenant_counters(uuid) TO app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS app.platform_tenant_counters(uuid);
    DROP FUNCTION IF EXISTS app.platform_otro_texts(text[], int);
    DROP FUNCTION IF EXISTS app.set_platform_limit_default(text, int);
  `);
};
