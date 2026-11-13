/**
 * D42 / F22: forecast snapshots.
 *
 *  - `tenant_forecast_snapshots`: one dated row per (tenant, month): the engine inputs and outputs, so the
 *    evolution of cost per conversation is traceable. Tenant read policy (own tenant) plus platform admin.
 *    app_user has SELECT only; rows are written by `app.store_forecast_snapshot`.
 *  - `app.forecast_history(p_tenant, p_month)`: THE history query. One jsonb array, newest first, of the 6
 *    complete months before `p_month` (America/Lima boundaries) that had activity: brands, products,
 *    deliverables by kind, alterations, turns, settled cost by usage kind, settled calls, recharges.
 *  - `app.store_forecast_snapshot(...)`: insert-if-missing. Both functions are SECURITY DEFINER and allow the
 *    tenant admin of `p_tenant` or the platform context (`app.is_platform_admin()`, set by the global tx).
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE tenant_forecast_snapshots (
      tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      month          date        NOT NULL CHECK (month = date_trunc('month', month)::date),
      inputs         jsonb       NOT NULL,
      forecast       jsonb       NOT NULL,
      engine_version text        NOT NULL CHECK (engine_version <> ''),
      created_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, month)
    );
    ALTER TABLE tenant_forecast_snapshots ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_forecast_snapshots FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_forecast_snapshots_read ON tenant_forecast_snapshots FOR SELECT
      USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin());
    GRANT SELECT ON tenant_forecast_snapshots TO app_user;

    CREATE FUNCTION app.forecast_history(p_tenant uuid, p_month date)
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    DECLARE result jsonb;
    BEGIN
      IF NOT ((p_tenant = app.current_tenant_id() AND app.has_tenant_admin()) OR app.is_platform_admin()) THEN
        RAISE EXCEPTION 'tenant admin or platform context required';
      END IF;
      WITH months AS (
        SELECT g::date AS month FROM generate_series(p_month - interval '6 months', p_month - interval '1 month', interval '1 month') g
      ),
      brands_m AS (
        SELECT date_trunc('month', created_at AT TIME ZONE 'America/Lima')::date AS month, count(*) AS n
          FROM public.brands WHERE tenant_id = p_tenant GROUP BY 1),
      products_m AS (
        SELECT date_trunc('month', created_at AT TIME ZONE 'America/Lima')::date AS month, count(*) AS n
          FROM public.products WHERE tenant_id = p_tenant GROUP BY 1),
      turns_m AS (
        SELECT date_trunc('month', created_at AT TIME ZONE 'America/Lima')::date AS month, count(*) AS n
          FROM public.messages WHERE tenant_id = p_tenant AND role = 'user' GROUP BY 1),
      deliv AS (
        SELECT date_trunc('month', d.created_at AT TIME ZONE 'America/Lima')::date AS month, d.kind::text AS kind,
               count(*) AS generated,
               count(*) FILTER (WHERE a.iteration_trigger IN ('user_reject', 'user_regenerate')) AS altered
          FROM public.deliverables d
          JOIN public.agent_tasks a ON a.tenant_id = d.tenant_id AND a.id = d.agent_task_id
         WHERE d.tenant_id = p_tenant GROUP BY 1, 2),
      cost_m AS (
        SELECT date_trunc('month', settled_at AT TIME ZONE 'America/Lima')::date AS month,
               coalesce(sum(actual_cost_usd) FILTER (WHERE kind = 'llm'), 0) AS llm,
               coalesce(sum(actual_cost_usd) FILTER (WHERE kind = 'image'), 0) AS image,
               count(*) AS calls
          FROM public.usage_reservations WHERE tenant_id = p_tenant AND status = 'settled' GROUP BY 1),
      recharge_m AS (
        SELECT date_trunc('month', created_at AT TIME ZONE 'America/Lima')::date AS month, sum(amount_usd) AS usd
          FROM public.tenant_credit_entries WHERE tenant_id = p_tenant AND kind = 'recharge' GROUP BY 1),
      rows AS (
        SELECT m.month,
               coalesce((SELECT n FROM brands_m b WHERE b.month = m.month), 0) AS brands,
               coalesce((SELECT n FROM products_m p WHERE p.month = m.month), 0) AS products,
               coalesce((SELECT jsonb_object_agg(kind, generated) FROM deliv x WHERE x.month = m.month), '{}'::jsonb) AS deliverables,
               coalesce((SELECT sum(altered) FROM deliv x WHERE x.month = m.month), 0) AS alterations,
               coalesce((SELECT n FROM turns_m t WHERE t.month = m.month), 0) AS turns,
               coalesce((SELECT llm FROM cost_m c WHERE c.month = m.month), 0) AS llm,
               coalesce((SELECT image FROM cost_m c WHERE c.month = m.month), 0) AS image,
               coalesce((SELECT calls FROM cost_m c WHERE c.month = m.month), 0) AS calls,
               coalesce((SELECT usd FROM recharge_m r WHERE r.month = m.month), 0) AS recharged
          FROM months m
      )
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'month', to_char(r.month, 'YYYY-MM-DD'), 'brands', r.brands, 'products', r.products,
          'deliverables', r.deliverables, 'alterations', r.alterations, 'turns', r.turns,
          'costUsd', jsonb_build_object('llm', r.llm, 'image', r.image),
          'settledCalls', r.calls, 'rechargedUsd', r.recharged) ORDER BY r.month DESC), '[]'::jsonb)
        INTO result
        FROM rows r
       WHERE r.brands + r.products + r.turns + r.calls > 0 OR r.deliverables <> '{}'::jsonb;
      RETURN result;
    END $fn$;
    REVOKE ALL ON FUNCTION app.forecast_history(uuid, date) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.forecast_history(uuid, date) TO app_user;

    CREATE FUNCTION app.store_forecast_snapshot(p_tenant uuid, p_month date, p_inputs jsonb, p_forecast jsonb, p_engine_version text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    BEGIN
      IF NOT ((p_tenant = app.current_tenant_id() AND app.has_tenant_admin()) OR app.is_platform_admin()) THEN
        RAISE EXCEPTION 'tenant admin or platform context required';
      END IF;
      INSERT INTO public.tenant_forecast_snapshots (tenant_id, month, inputs, forecast, engine_version)
        VALUES (p_tenant, p_month, p_inputs, p_forecast, p_engine_version)
        ON CONFLICT (tenant_id, month) DO NOTHING;
    END $fn$;
    REVOKE ALL ON FUNCTION app.store_forecast_snapshot(uuid, date, jsonb, jsonb, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.store_forecast_snapshot(uuid, date, jsonb, jsonb, text) TO app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS app.store_forecast_snapshot(uuid, date, jsonb, jsonb, text);
    DROP FUNCTION IF EXISTS app.forecast_history(uuid, date);
    DROP TABLE IF EXISTS tenant_forecast_snapshots;
  `);
};
