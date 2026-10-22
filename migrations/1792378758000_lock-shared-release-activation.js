/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.lock_frozen_shared_release(target_release_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp AS $$
    DECLARE is_frozen boolean;
    BEGIN
      IF NOT app.has_active_member() OR NOT app.has_tenant_admin() THEN
        RETURN false;
      END IF;
      SELECT status = 'frozen' INTO is_frozen
        FROM public.ai_shared_releases
       WHERE id = target_release_id
       FOR SHARE;
      RETURN COALESCE(is_frozen, false);
    END $$;
    REVOKE ALL ON FUNCTION app.lock_frozen_shared_release(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lock_frozen_shared_release(uuid) TO app_user;

    CREATE OR REPLACE FUNCTION app.guard_release_activation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE r ai_releases%ROWTYPE;
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      SELECT * INTO r FROM ai_releases WHERE tenant_id = NEW.tenant_id AND id = NEW.release_id FOR SHARE;
      IF NOT FOUND OR r.status <> 'frozen' THEN RAISE EXCEPTION 'only a frozen local release can be activated'; END IF;
      IF r.base_shared_release_id IS NOT NULL
         AND NOT app.lock_frozen_shared_release(r.base_shared_release_id) THEN
        RAISE EXCEPTION 'shared release is retired or unavailable';
      END IF;
      RETURN NEW;
    END $$;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.guard_release_activation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE r ai_releases%ROWTYPE; base_status text;
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      SELECT * INTO r FROM ai_releases WHERE tenant_id = NEW.tenant_id AND id = NEW.release_id FOR SHARE;
      IF NOT FOUND OR r.status <> 'frozen' THEN RAISE EXCEPTION 'only a frozen local release can be activated'; END IF;
      IF r.base_shared_release_id IS NOT NULL THEN
        SELECT status INTO base_status FROM ai_shared_releases WHERE id = r.base_shared_release_id FOR SHARE;
        IF base_status IS DISTINCT FROM 'frozen' THEN RAISE EXCEPTION 'shared release is retired or unavailable'; END IF;
      END IF;
      RETURN NEW;
    END $$;
    DROP FUNCTION IF EXISTS app.lock_frozen_shared_release(uuid);
  `);
};
