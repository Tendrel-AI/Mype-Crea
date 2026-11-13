/**
 * D38 / D39: limit profiles. Limits attach to a PROFILE, never to the tenant or the user directly.
 *
 *  - `limit_profiles` (tenant-scoped, named, exactly one `is_default` per tenant) and
 *    `limit_profile_values` (one row per limit key; the key shape is validated here, the catalog of
 *    valid keys lives in code: `src/core/limits/catalog.ts`).
 *  - `users.limit_profile_id` (nullable): the user's own profile; NULL falls back to the tenant default.
 *  - `entitlements`: the future assignment of a profile to a user (tiers, payment gateway). Recorded
 *    only; the resolver does not read it yet. Idempotent per (tenant, source, external_ref).
 *  - `platform_limit_defaults`: global, one row per key, what a new tenant's default profile starts from.
 *  - `limit_profile_audit_events`: append-only trail of every value change (actor, before, after, reason).
 *  - Profile values are written ONLY through `app.set_limit_profile_value` (SECURITY DEFINER): it
 *    re-checks the tenant admin role, the 0..1000 range and the profile's tenant, then writes the
 *    value and its audit row. app_user has SELECT only on the tables.
 *  - Every tenant (existing and new, via trigger) gets a «Por defecto» profile. Existing tenants are
 *    seeded from `tenants.max_brands_per_user` / `max_products_per_brand`.
 *  - DEPRECATED, add-only (nothing reads them any more; dropped in a later deploy):
 *    `tenants.max_brands_per_user`, `tenants.max_conversations_per_brand`, `tenants.max_products_per_brand`,
 *    `app.set_brand_limits`, `app.set_brand_product_limits`.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(String.raw`
    CREATE TABLE platform_limit_defaults (
      limit_key  text        NOT NULL CHECK (limit_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]{0,62}$'),
      value      int         NOT NULL CHECK (value >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (limit_key)
    );
    INSERT INTO platform_limit_defaults (limit_key, value) VALUES
      ('alterations.logo-agent', 3),
      ('alterations.name-agent', 3),
      ('alterations.tagline-agent', 3),
      ('alterations.label-agent', 3),
      ('turns.per_conversation', 40),
      ('brands.per_user', 3),
      ('products.per_brand', 5);

    CREATE TABLE limit_profiles (
      id         uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      is_default boolean     NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, name)
    );
    CREATE UNIQUE INDEX limit_profiles_one_default ON limit_profiles (tenant_id) WHERE is_default;

    CREATE TABLE limit_profile_values (
      tenant_id  uuid        NOT NULL,
      profile_id uuid        NOT NULL,
      limit_key  text        NOT NULL CHECK (limit_key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]{0,62}$'),
      value      int         NOT NULL CHECK (value >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, limit_key),
      FOREIGN KEY (tenant_id, profile_id) REFERENCES limit_profiles(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX limit_profile_values_tenant ON limit_profile_values (tenant_id, profile_id);

    ALTER TABLE users ADD COLUMN limit_profile_id uuid;
    ALTER TABLE users ADD CONSTRAINT users_limit_profile_fk
      FOREIGN KEY (tenant_id, limit_profile_id) REFERENCES limit_profiles(tenant_id, id) ON DELETE RESTRICT;

    CREATE TABLE entitlements (
      id           uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id    uuid        NOT NULL,
      user_id      uuid        NOT NULL,
      profile_id   uuid        NOT NULL,
      status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
      valid_from   timestamptz NOT NULL DEFAULT now(),
      valid_to     timestamptz,
      source       text        NOT NULL CHECK (source IN ('admin', 'self', 'gateway')),
      external_ref text        CHECK (char_length(external_ref) <= 200),
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, user_id)    REFERENCES users(tenant_id, id)          ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, profile_id) REFERENCES limit_profiles(tenant_id, id) ON DELETE RESTRICT,
      CHECK (valid_to IS NULL OR valid_to > valid_from)
    );
    CREATE UNIQUE INDEX entitlements_external_ref ON entitlements (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL;
    CREATE INDEX entitlements_tenant_user ON entitlements (tenant_id, user_id, status);

    CREATE TABLE limit_profile_audit_events (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL,
      actor_user_id uuid        NOT NULL,
      profile_id    uuid        NOT NULL,
      limit_key     text        NOT NULL,
      before_value  int,
      after_value   int         NOT NULL,
      reason        text        CHECK (char_length(reason) <= 500),
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)          ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, profile_id)    REFERENCES limit_profiles(tenant_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX limit_profile_audit_tenant_created ON limit_profile_audit_events (tenant_id, created_at DESC);

    ALTER TABLE platform_limit_defaults    ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_limit_defaults    FORCE  ROW LEVEL SECURITY;
    ALTER TABLE limit_profiles             ENABLE ROW LEVEL SECURITY;
    ALTER TABLE limit_profiles             FORCE  ROW LEVEL SECURITY;
    ALTER TABLE limit_profile_values       ENABLE ROW LEVEL SECURITY;
    ALTER TABLE limit_profile_values       FORCE  ROW LEVEL SECURITY;
    ALTER TABLE entitlements               ENABLE ROW LEVEL SECURITY;
    ALTER TABLE entitlements               FORCE  ROW LEVEL SECURITY;
    ALTER TABLE limit_profile_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE limit_profile_audit_events FORCE  ROW LEVEL SECURITY;

    CREATE POLICY platform_limit_defaults_read ON platform_limit_defaults FOR SELECT USING (true);
    CREATE POLICY limit_profiles_read ON limit_profiles FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY limit_profile_values_read ON limit_profile_values FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY entitlements_read ON entitlements FOR SELECT
      USING (tenant_id = app.current_tenant_id() AND (user_id = app.current_user_id() OR app.has_tenant_admin()));
    CREATE POLICY limit_profile_audit_read ON limit_profile_audit_events FOR SELECT
      USING (tenant_id = app.current_tenant_id() AND app.has_tenant_admin());

    GRANT SELECT ON platform_limit_defaults, limit_profiles, limit_profile_values, entitlements, limit_profile_audit_events TO app_user;

    CREATE FUNCTION app.set_limit_profile_value(p_profile_id uuid, p_limit_key text, p_value int, p_reason text)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    DECLARE
      v_tenant uuid := app.current_tenant_id();
      v_stored int;
      v_before int;
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      IF p_value IS NULL OR p_value NOT BETWEEN 0 AND 1000 THEN
        RAISE EXCEPTION 'limit value must be between 0 and 1000';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.limit_profiles WHERE id = p_profile_id AND tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'limit profile not found';
      END IF;
      SELECT value INTO v_stored FROM public.limit_profile_values
       WHERE tenant_id = v_tenant AND profile_id = p_profile_id AND limit_key = p_limit_key;
      IF v_stored = p_value THEN RETURN; END IF;
      v_before := coalesce(v_stored, (SELECT value FROM public.platform_limit_defaults WHERE limit_key = p_limit_key));
      INSERT INTO public.limit_profile_values (tenant_id, profile_id, limit_key, value)
      VALUES (v_tenant, p_profile_id, p_limit_key, p_value)
      ON CONFLICT (profile_id, limit_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
      INSERT INTO public.limit_profile_audit_events (tenant_id, actor_user_id, profile_id, limit_key, before_value, after_value, reason)
      VALUES (v_tenant, app.current_user_id(), p_profile_id, p_limit_key, v_before, p_value, nullif(left(p_reason, 500), ''));
    END $$;
    REVOKE ALL ON FUNCTION app.set_limit_profile_value(uuid, text, int, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.set_limit_profile_value(uuid, text, int, text) TO app_user;

    -- Creates the tenant's «Por defecto» profile from the platform defaults (the two count keys can be overridden).
    CREATE FUNCTION app.seed_default_limit_profile(p_tenant_id uuid, p_brands int DEFAULT NULL, p_products int DEFAULT NULL)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    DECLARE v_profile uuid;
    BEGIN
      INSERT INTO public.limit_profiles (tenant_id, name, is_default)
      VALUES (p_tenant_id, 'Por defecto', true)
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_profile;
      IF v_profile IS NULL THEN RETURN; END IF;
      INSERT INTO public.limit_profile_values (tenant_id, profile_id, limit_key, value)
      SELECT p_tenant_id, v_profile, d.limit_key,
             CASE d.limit_key WHEN 'brands.per_user' THEN coalesce(p_brands, d.value)
                              WHEN 'products.per_brand' THEN coalesce(p_products, d.value)
                              ELSE d.value END
        FROM public.platform_limit_defaults d;
    END $$;
    REVOKE ALL ON FUNCTION app.seed_default_limit_profile(uuid, int, int) FROM PUBLIC;

    CREATE FUNCTION app.tenants_seed_limit_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    BEGIN
      PERFORM app.seed_default_limit_profile(NEW.id);
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION app.tenants_seed_limit_profile() FROM PUBLIC;
    CREATE TRIGGER tenants_seed_limit_profile AFTER INSERT ON tenants
      FOR EACH ROW EXECUTE FUNCTION app.tenants_seed_limit_profile();

    -- Backfill: FORCE RLS applies to the migration role too, so read tenants with row_security off (as seed-pilot does).
    SET LOCAL row_security = off;
    SELECT app.seed_default_limit_profile(id, max_brands_per_user, max_products_per_brand) FROM tenants;

    COMMENT ON COLUMN tenants.max_brands_per_user IS 'DEPRECATED (D38): migrated into the default limit profile (brands.per_user); nothing reads it.';
    COMMENT ON COLUMN tenants.max_products_per_brand IS 'DEPRECATED (D38): migrated into the default limit profile (products.per_brand); nothing reads it.';
    COMMENT ON COLUMN tenants.max_conversations_per_brand IS 'DEPRECATED (D40/D44): conversations per brand are not limited; nothing reads it.';
    COMMENT ON FUNCTION app.set_brand_limits(int, int) IS 'DEPRECATED (D38): use app.set_limit_profile_value. Writes a dead column.';
    COMMENT ON FUNCTION app.set_brand_product_limits(int, int) IS 'DEPRECATED (D38): use app.set_limit_profile_value. Writes a dead column.';
    COMMENT ON TABLE limit_profile_audit_events IS 'D38: append-only audit of every limit profile value change; written only by app.set_limit_profile_value.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS tenants_seed_limit_profile ON tenants;
    DROP FUNCTION IF EXISTS app.tenants_seed_limit_profile();
    DROP FUNCTION IF EXISTS app.seed_default_limit_profile(uuid, int, int);
    DROP FUNCTION IF EXISTS app.set_limit_profile_value(uuid, text, int, text);
    DROP TABLE IF EXISTS limit_profile_audit_events;
    DROP TABLE IF EXISTS entitlements;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_limit_profile_fk;
    ALTER TABLE users DROP COLUMN IF EXISTS limit_profile_id;
    DROP TABLE IF EXISTS limit_profile_values;
    DROP TABLE IF EXISTS limit_profiles;
    DROP TABLE IF EXISTS platform_limit_defaults;
  `);
};
