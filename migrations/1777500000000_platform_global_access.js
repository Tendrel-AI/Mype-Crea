/**
 * Platform metadata access. These tables contain global identity/configuration
 * metadata only; no tenant conversation, message, member, or artifact content.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'inactive'));
    ALTER TABLE tenants ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

    CREATE TABLE platform_superadmins (
      workos_user_id text PRIMARY KEY,
      granted_at timestamptz NOT NULL DEFAULT now(),
      granted_by_workos_user_id text,
      grant_source text NOT NULL CHECK (grant_source IN ('bootstrap', 'authorized')),
      revoked_at timestamptz,
      revoked_by_workos_user_id text,
      CHECK ((revoked_at IS NULL) = (revoked_by_workos_user_id IS NULL))
    );
    CREATE TABLE platform_bootstrap_state (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      completed_at timestamptz NOT NULL,
      initial_superadmin_workos_user_id text NOT NULL
    );
    CREATE TABLE platform_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_workos_user_id text,
      action text NOT NULL,
      scope_type text NOT NULL,
      scope_id text,
      prior_version text,
      new_version text,
      outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
      reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX platform_audit_events_created_idx ON platform_audit_events (created_at DESC);
    CREATE INDEX platform_audit_events_scope_idx ON platform_audit_events (scope_type, scope_id, created_at DESC);

    CREATE TABLE platform_org_operations (
      operation_key text PRIMARY KEY,
      tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
      workos_org_id text UNIQUE,
      requested_name text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('create', 'update', 'deactivate', 'reactivate')),
      status text NOT NULL CHECK (status IN ('pending', 'complete', 'reconciliation_required')),
      error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE platform_module_versions (
      module_id text NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      operation_key text UNIQUE,
      config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
      shared_release_id uuid REFERENCES ai_shared_releases(id) ON DELETE RESTRICT,
      created_by_workos_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      previous_version integer,
      PRIMARY KEY (module_id, version),
      FOREIGN KEY (module_id, previous_version) REFERENCES platform_module_versions(module_id, version)
    );
    CREATE TABLE platform_module_defaults (
      module_id text PRIMARY KEY,
      version integer NOT NULL,
      updated_by_workos_user_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (module_id, version) REFERENCES platform_module_versions(module_id, version)
    );
    CREATE TABLE platform_module_assignments (
      module_id text NOT NULL,
      organization_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      version integer NOT NULL,
      updated_by_workos_user_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module_id, organization_id),
      FOREIGN KEY (module_id, version) REFERENCES platform_module_versions(module_id, version)
    );
    CREATE TABLE platform_module_operations (
      operation_key text PRIMARY KEY,
      module_id text NOT NULL,
      target_scope text NOT NULL CHECK (target_scope IN ('one', 'selected', 'all', 'default')),
      target_organization_ids uuid[] NOT NULL DEFAULT '{}',
      version integer NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'complete', 'partial', 'failed')),
      results jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(results) = 'object'),
      created_by_workos_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (module_id, version) REFERENCES platform_module_versions(module_id, version)
    );

    CREATE OR REPLACE FUNCTION app.is_platform_actor() RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT coalesce(
        app.is_platform_admin() AND EXISTS (
          SELECT 1 FROM public.platform_superadmins s
           WHERE s.workos_user_id = current_setting('app.platform_actor_workos_user_id', true)
             AND s.revoked_at IS NULL
        ), false
      )
    $$;
    GRANT EXECUTE ON FUNCTION app.is_platform_actor() TO app_user;

    CREATE OR REPLACE FUNCTION app.platform_tenant_ai_release(target_tenant_id uuid)
    RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $$
    DECLARE selected_release uuid;
    BEGIN
      IF NOT app.is_platform_actor() THEN RAISE EXCEPTION 'active platform actor context is required'; END IF;
      SELECT activation.release_id INTO selected_release
        FROM public.ai_release_activations activation
        JOIN public.ai_releases release
          ON release.tenant_id=activation.tenant_id AND release.id=activation.release_id
       WHERE activation.tenant_id=target_tenant_id AND release.status='frozen';
      RETURN selected_release;
    END $$;
    REVOKE ALL ON FUNCTION app.platform_tenant_ai_release(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_tenant_ai_release(uuid) TO app_user;

    CREATE POLICY tenants_platform_metadata ON tenants TO app_user
      USING (app.is_platform_admin()) WITH CHECK (app.is_platform_actor());
    DROP POLICY ai_shared_releases_read ON ai_shared_releases;
    DROP POLICY ai_shared_releases_insert ON ai_shared_releases;
    DROP POLICY ai_shared_releases_update ON ai_shared_releases;
    CREATE POLICY ai_shared_releases_read ON ai_shared_releases FOR SELECT TO app_user
      USING (app.is_platform_actor() OR (app.has_active_member() AND app.has_tenant_admin()));
    CREATE POLICY ai_shared_releases_insert ON ai_shared_releases FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor() OR (app.has_active_member() AND app.is_platform_admin()));
    CREATE POLICY ai_shared_releases_update ON ai_shared_releases FOR UPDATE TO app_user
      USING (app.is_platform_actor() OR (app.has_active_member() AND app.is_platform_admin()))
      WITH CHECK (app.is_platform_actor() OR (app.has_active_member() AND app.is_platform_admin()));

    CREATE POLICY ai_shared_releases_selected_member_read ON ai_shared_releases FOR SELECT TO app_user
      USING (app.has_active_member() AND (
        EXISTS (
          SELECT 1 FROM public.platform_module_assignments a
          JOIN public.platform_module_versions v ON v.module_id=a.module_id AND v.version=a.version
          WHERE a.organization_id=app.current_tenant_id() AND v.shared_release_id=ai_shared_releases.id
        ) OR EXISTS (
          SELECT 1 FROM public.platform_module_defaults d
          JOIN public.platform_module_versions v ON v.module_id=d.module_id AND v.version=d.version
          WHERE v.shared_release_id=ai_shared_releases.id
            AND NOT EXISTS (SELECT 1 FROM public.platform_module_assignments a
              WHERE a.organization_id=app.current_tenant_id() AND a.module_id=d.module_id)
        )
      ));

    CREATE OR REPLACE FUNCTION app.reject_platform_metadata_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'platform audit and module versions are append-only'; END $$;
    CREATE TRIGGER platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit_events
      FOR EACH ROW EXECUTE FUNCTION app.reject_platform_metadata_mutation();
    CREATE TRIGGER platform_module_versions_immutable BEFORE UPDATE OR DELETE ON platform_module_versions
      FOR EACH ROW EXECUTE FUNCTION app.reject_platform_metadata_mutation();

    ALTER TABLE ai_releases ADD COLUMN is_platform_materialization boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX ai_releases_platform_clone_unique
      ON ai_releases (tenant_id, base_shared_release_id, content_hash)
      WHERE is_platform_materialization AND base_shared_release_id IS NOT NULL AND content_hash IS NOT NULL;

    CREATE OR REPLACE FUNCTION app.platform_monthly_metrics(requested_month date)
    RETURNS TABLE (
      period_start date,
      organization_id uuid,
      organization_name text,
      active_users bigint,
      new_conversations bigint,
      provider_model_usage jsonb,
      estimated_cost numeric,
      errors bigint,
      active_versions jsonb
    )
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $$
    DECLARE month_end date;
    BEGIN
      IF requested_month IS NULL OR date_trunc('month', requested_month)::date <> requested_month THEN
        RAISE EXCEPTION 'requested_month must be the first day of a calendar month';
      END IF;
      IF NOT app.is_platform_actor() THEN
        RAISE EXCEPTION 'active platform actor context is required';
      END IF;
      month_end := (requested_month + interval '1 month')::date;

      RETURN QUERY
      WITH organizations AS (
        SELECT t.id, t.name FROM public.tenants t
      ), activity AS (
        SELECT c.tenant_id, count(*)::bigint AS new_conversations
          FROM public.conversations c
         WHERE c.started_at >= requested_month AND c.started_at < month_end
         GROUP BY c.tenant_id
      ), active AS (
        SELECT m.tenant_id, count(DISTINCT m.user_id)::bigint AS active_users
          FROM public.messages m
         WHERE m.role = 'user' AND m.created_at >= requested_month AND m.created_at < month_end
         GROUP BY m.tenant_id
      ), error_events AS (
        SELECT a.tenant_id, a.id AS error_id, 'attempt'::text AS source
          FROM public.ai_turn_attempts a
         WHERE a.status IN ('failed', 'uncertain')
           AND a.started_at >= requested_month AND a.started_at < month_end
        UNION ALL
        SELECT t.tenant_id, t.id, 'task'
          FROM public.agent_tasks t
         WHERE t.status = 'failed' AND t.created_at >= requested_month AND t.created_at < month_end
        UNION ALL
        SELECT m.tenant_id, m.id, 'message'
          FROM public.messages m
         WHERE m.generation_status = 'failed' AND m.created_at >= requested_month AND m.created_at < month_end
      ), errors_by_org AS (
        SELECT tenant_id, count(*)::bigint AS errors FROM error_events GROUP BY tenant_id
      ), usage_model AS (
        SELECT a.tenant_id, a.provider, a.model,
          count(*)::bigint AS calls,
          coalesce(sum(a.input_tokens), 0)::bigint AS input_tokens,
          coalesce(sum(a.output_tokens), 0)::bigint AS output_tokens,
          count(*) FILTER (WHERE a.status IN ('failed', 'uncertain'))::bigint AS failures,
          coalesce(sum(a.cost_amount) FILTER (WHERE a.cost_source = 'estimated'), 0)::numeric AS estimated_cost
        FROM public.ai_turn_attempts a
        WHERE a.started_at >= requested_month AND a.started_at < month_end
        GROUP BY a.tenant_id, a.provider, a.model
      ), usage_cost AS (
        SELECT a.tenant_id, a.provider, a.model, a.cost_currency, a.cost_source,
          sum(a.cost_amount)::numeric AS amount
        FROM public.ai_turn_attempts a
        WHERE a.started_at >= requested_month AND a.started_at < month_end
          AND a.cost_amount IS NOT NULL
        GROUP BY a.tenant_id, a.provider, a.model, a.cost_currency, a.cost_source
      ), usage_by_org AS (
        SELECT u.tenant_id,
          jsonb_agg(jsonb_build_object(
            'provider', u.provider, 'model', u.model, 'calls', u.calls,
            'inputTokens', u.input_tokens, 'outputTokens', u.output_tokens, 'errors', u.failures,
            'estimatedCost', u.estimated_cost, 'costs', coalesce(costs.items, '[]'::jsonb)
          ) ORDER BY u.provider, u.model) AS items,
          sum(u.estimated_cost)::numeric AS estimated_cost,
          sum(u.failures)::bigint AS errors
        FROM usage_model u
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('currency', c.cost_currency,
            'source', c.cost_source, 'amount', c.amount)
            ORDER BY c.cost_currency, c.cost_source) AS items
          FROM usage_cost c
          WHERE c.tenant_id = u.tenant_id AND c.provider = u.provider AND c.model = u.model
        ) costs ON true
        GROUP BY u.tenant_id
      ), version_rows AS (
        SELECT a.tenant_id, 2 AS priority, jsonb_build_object('moduleId', 'ai', 'version', a.version,
          'releaseId', r.id, 'name', r.name) AS value
          FROM public.ai_release_activations a
          JOIN public.ai_releases r ON r.tenant_id = a.tenant_id AND r.id = a.release_id
        UNION ALL
        SELECT x.organization_id AS tenant_id, 1 AS priority, jsonb_build_object('moduleId', x.module_id,
          'version', x.version, 'sharedReleaseId', v.shared_release_id) AS value
          FROM public.platform_module_assignments x
          JOIN public.platform_module_versions v ON v.module_id=x.module_id AND v.version=x.version
        UNION ALL
        SELECT o.id AS tenant_id, 3 AS priority, jsonb_build_object('moduleId', d.module_id,
          'version', d.version, 'sharedReleaseId', v.shared_release_id) AS value
          FROM organizations o
          JOIN public.platform_module_defaults d ON true
          JOIN public.platform_module_versions v ON v.module_id=d.module_id AND v.version=d.version
         WHERE NOT EXISTS (SELECT 1 FROM public.platform_module_assignments x
           WHERE x.organization_id=o.id AND x.module_id=d.module_id)
      ), versions_by_org AS (
        SELECT tenant_id, jsonb_agg(value ORDER BY value->>'moduleId') AS items
          FROM (
            SELECT DISTINCT ON (tenant_id, value->>'moduleId') tenant_id, value
              FROM version_rows
             ORDER BY tenant_id, value->>'moduleId', priority
          ) effective
         GROUP BY tenant_id
      ), platform_usage_model AS (
        SELECT u.provider, u.model, sum(u.calls)::bigint AS calls,
          sum(u.input_tokens)::bigint AS input_tokens, sum(u.output_tokens)::bigint AS output_tokens,
          sum(u.failures)::bigint AS failures, sum(u.estimated_cost)::numeric AS estimated_cost
          FROM usage_model u GROUP BY u.provider, u.model
      ), platform_cost AS (
        SELECT c.provider, c.model, c.cost_currency, c.cost_source, sum(c.amount)::numeric AS amount
          FROM usage_cost c GROUP BY c.provider, c.model, c.cost_currency, c.cost_source
      ), platform_usage AS (
        SELECT jsonb_agg(jsonb_build_object(
          'provider', u.provider, 'model', u.model, 'calls', u.calls,
          'inputTokens', u.input_tokens, 'outputTokens', u.output_tokens, 'errors', u.failures,
          'estimatedCost', u.estimated_cost, 'costs', coalesce(costs.items, '[]'::jsonb)
        ) ORDER BY u.provider, u.model) AS items,
        coalesce(sum(u.estimated_cost), 0)::numeric AS estimated_cost,
        coalesce(sum(u.failures), 0)::bigint AS errors
        FROM platform_usage_model u
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('currency', c.cost_currency,
            'source', c.cost_source, 'amount', c.amount)
            ORDER BY c.cost_currency, c.cost_source) AS items
          FROM platform_cost c WHERE c.provider=u.provider AND c.model=u.model
        ) costs ON true
      )
      SELECT requested_month, o.id, o.name, coalesce(ac.active_users, 0),
        coalesce(a.new_conversations, 0), coalesce(u.items, '[]'::jsonb),
        coalesce(u.estimated_cost, 0), coalesce(err.errors, 0),
        coalesce(v.items, '[]'::jsonb)
      FROM organizations o
      LEFT JOIN active ac ON ac.tenant_id = o.id
      LEFT JOIN activity a ON a.tenant_id = o.id
      LEFT JOIN usage_by_org u ON u.tenant_id = o.id
      LEFT JOIN errors_by_org err ON err.tenant_id = o.id
      LEFT JOIN versions_by_org v ON v.tenant_id = o.id
      UNION ALL
      SELECT requested_month, NULL::uuid, 'Plataforma',
        (SELECT count(DISTINCT (m.tenant_id, m.user_id))::bigint
           FROM public.messages m WHERE m.role='user' AND m.created_at >= requested_month AND m.created_at < month_end),
        (SELECT count(*)::bigint FROM public.conversations c WHERE c.started_at >= requested_month AND c.started_at < month_end),
        coalesce(pu.items, '[]'::jsonb), coalesce(pu.estimated_cost, 0),
        (SELECT count(*)::bigint FROM error_events),
        coalesce((SELECT jsonb_agg(jsonb_build_object('moduleId', effective.module_id,
          'version', effective.version, 'organizations', effective.organizations)
          ORDER BY effective.module_id)
          FROM (
            SELECT v.module_id, v.version, count(DISTINCT v.tenant_id)::bigint AS organizations
              FROM (
                SELECT DISTINCT ON (tenant_id, value->>'moduleId') tenant_id,
                  value->>'moduleId' AS module_id, (value->>'version')::integer AS version, value
                  FROM version_rows
                 ORDER BY tenant_id, value->>'moduleId', priority
              ) v
             GROUP BY v.module_id, v.version
          ) effective), '[]'::jsonb)
      FROM platform_usage pu;
    END $$;
    REVOKE ALL ON FUNCTION app.platform_monthly_metrics(date) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.platform_monthly_metrics(date) TO app_user;

    ALTER TABLE platform_superadmins ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_superadmins FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_bootstrap_state ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_bootstrap_state FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_audit_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_org_operations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_org_operations FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_versions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_versions FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_defaults ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_defaults FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_assignments FORCE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_operations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_module_operations FORCE ROW LEVEL SECURITY;

    CREATE POLICY platform_superadmins_read ON platform_superadmins FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_superadmins_actor_update ON platform_superadmins FOR UPDATE TO app_user
      USING (app.is_platform_actor()) WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_superadmins_insert ON platform_superadmins FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor() OR current_setting('app.platform_bootstrap', true) = 'true');
    CREATE POLICY platform_bootstrap_read ON platform_bootstrap_state FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_bootstrap_insert ON platform_bootstrap_state FOR INSERT TO app_user
      WITH CHECK (current_setting('app.platform_bootstrap', true) = 'true');
    CREATE POLICY platform_audit_read ON platform_audit_events FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_audit_insert ON platform_audit_events FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_org_operations_read ON platform_org_operations FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_org_operations_insert ON platform_org_operations FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_org_operations_update ON platform_org_operations FOR UPDATE TO app_user
      USING (app.is_platform_actor()) WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_versions_read ON platform_module_versions FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_module_versions_insert ON platform_module_versions FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_defaults_read ON platform_module_defaults FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_module_defaults_insert ON platform_module_defaults FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_defaults_update ON platform_module_defaults FOR UPDATE TO app_user
      USING (app.is_platform_actor()) WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_defaults_member_read ON platform_module_defaults FOR SELECT TO app_user
      USING (app.has_active_member());
    CREATE POLICY platform_module_assignments_read ON platform_module_assignments FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_module_assignments_insert ON platform_module_assignments FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_assignments_update ON platform_module_assignments FOR UPDATE TO app_user
      USING (app.is_platform_actor()) WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_assignments_member_read ON platform_module_assignments FOR SELECT TO app_user
      USING (organization_id = app.current_tenant_id() AND app.has_active_member());
    CREATE POLICY platform_module_operations_read ON platform_module_operations FOR SELECT TO app_user
      USING (app.is_platform_admin());
    CREATE POLICY platform_module_operations_insert ON platform_module_operations FOR INSERT TO app_user
      WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_operations_update ON platform_module_operations FOR UPDATE TO app_user
      USING (app.is_platform_actor()) WITH CHECK (app.is_platform_actor());
    CREATE POLICY platform_module_versions_member_read ON platform_module_versions FOR SELECT TO app_user
      USING (app.has_active_member() AND (
        EXISTS (SELECT 1 FROM public.platform_module_defaults d
          WHERE d.module_id = platform_module_versions.module_id AND d.version = platform_module_versions.version)
        OR EXISTS (SELECT 1 FROM public.platform_module_assignments a
          WHERE a.module_id = platform_module_versions.module_id AND a.version = platform_module_versions.version
            AND a.organization_id = app.current_tenant_id())
      ));

    GRANT SELECT, INSERT, UPDATE ON platform_superadmins TO app_user;
    GRANT SELECT, INSERT ON platform_bootstrap_state TO app_user;
    GRANT SELECT, INSERT, UPDATE ON platform_org_operations, platform_module_defaults,
      platform_module_assignments, platform_module_operations TO app_user;
    GRANT SELECT, INSERT ON platform_module_versions TO app_user;
    GRANT SELECT, INSERT ON platform_audit_events TO app_user;
    REVOKE INSERT, UPDATE ON tenants FROM app_user;
    GRANT INSERT (kind, name, plan, workos_org_id, status) ON tenants TO app_user;
    GRANT UPDATE (name, workos_org_id, status, updated_at) ON tenants TO app_user;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    REVOKE ALL ON FUNCTION app.platform_tenant_ai_release(uuid) FROM app_user, PUBLIC;
    DROP FUNCTION IF EXISTS app.platform_tenant_ai_release(uuid);
    REVOKE ALL ON FUNCTION app.platform_monthly_metrics(date) FROM app_user, PUBLIC;
    DROP FUNCTION IF EXISTS app.platform_monthly_metrics(date);
    DROP TRIGGER IF EXISTS platform_module_versions_immutable ON platform_module_versions;
    DROP TRIGGER IF EXISTS platform_audit_append_only ON platform_audit_events;
    DROP FUNCTION IF EXISTS app.reject_platform_metadata_mutation();
    DROP POLICY IF EXISTS tenants_platform_metadata ON tenants;
    DROP POLICY IF EXISTS ai_shared_releases_selected_member_read ON ai_shared_releases;
    DROP POLICY IF EXISTS ai_shared_releases_read ON ai_shared_releases;
    DROP POLICY IF EXISTS ai_shared_releases_insert ON ai_shared_releases;
    DROP POLICY IF EXISTS ai_shared_releases_update ON ai_shared_releases;
    DROP POLICY IF EXISTS platform_module_versions_member_read ON platform_module_versions;
    DROP POLICY IF EXISTS platform_module_assignments_member_read ON platform_module_assignments;
    DROP POLICY IF EXISTS platform_module_defaults_member_read ON platform_module_defaults;
    CREATE POLICY ai_shared_releases_read ON ai_shared_releases FOR SELECT
      USING (app.has_active_member() AND (app.is_platform_admin() OR app.has_tenant_admin()));
    CREATE POLICY ai_shared_releases_insert ON ai_shared_releases FOR INSERT
      WITH CHECK (app.has_active_member() AND app.is_platform_admin());
    CREATE POLICY ai_shared_releases_update ON ai_shared_releases FOR UPDATE
      USING (app.has_active_member() AND app.is_platform_admin())
      WITH CHECK (app.has_active_member() AND app.is_platform_admin());
    REVOKE ALL ON platform_superadmins, platform_bootstrap_state, platform_audit_events,
      platform_org_operations, platform_module_versions, platform_module_defaults,
      platform_module_assignments, platform_module_operations FROM app_user;
    DROP TABLE IF EXISTS platform_module_operations;
    DROP TABLE IF EXISTS platform_module_assignments;
    DROP TABLE IF EXISTS platform_module_defaults;
    DROP TABLE IF EXISTS platform_module_versions;
    DROP TABLE IF EXISTS platform_org_operations;
    DROP TABLE IF EXISTS platform_audit_events;
    DROP TABLE IF EXISTS platform_bootstrap_state;
    DROP TABLE IF EXISTS platform_superadmins;
    DROP INDEX IF EXISTS ai_releases_platform_clone_unique;
    ALTER TABLE ai_releases DROP COLUMN IF EXISTS is_platform_materialization;
    GRANT INSERT, UPDATE ON tenants TO app_user;
    DROP FUNCTION IF EXISTS app.is_platform_actor();
    ALTER TABLE tenants DROP COLUMN IF EXISTS updated_at;
    ALTER TABLE tenants DROP COLUMN IF EXISTS status;
  `);
};
