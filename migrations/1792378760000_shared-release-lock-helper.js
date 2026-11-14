/**
 * KAN-70 forward repair: shared-release row locks for activation and pinning.
 *
 * The activation and conversation-pin triggers from 1777420000000 lock the base
 * shared release with `SELECT ... FOR SHARE` so a concurrent retirement waits.
 * Under RLS a row lock also requires the UPDATE policy, which is platform-only on
 * ai_shared_releases, so tenant admins and members never saw the row and every
 * activation/pin of a shared-based release failed as "retired or unavailable".
 *
 * This migration replaces those direct locks with one narrow SECURITY DEFINER
 * helper instead of widening the tenant UPDATE policy or privileges. The helper:
 *  - requires an active member of the current tenant, plus either
 *    - an active tenant admin (activation; the trigger also requires it), or
 *    - the requested release being the shared base of the tenant's current
 *      active local release (conversation pins by any active member);
 *  - locks only the requested shared release row (FOR SHARE);
 *  - returns only whether that release is frozen, never its content.
 * It is a forward migration so already-migrated databases receive the fix
 * without replaying 1777420000000.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION app.lock_frozen_shared_release(target_release_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    DECLARE is_frozen boolean;
    BEGIN
      IF target_release_id IS NULL OR NOT app.has_active_member() THEN
        RETURN false;
      END IF;
      IF NOT app.has_tenant_admin() AND NOT EXISTS (
        SELECT 1
          FROM public.ai_release_activations activation
          JOIN public.ai_releases release
            ON release.tenant_id = activation.tenant_id
           AND release.id = activation.release_id
         WHERE activation.tenant_id = app.current_tenant_id()
           AND release.base_shared_release_id = target_release_id
      ) THEN
        RETURN false;
      END IF;
      SELECT shared.status = 'frozen' INTO is_frozen
        FROM public.ai_shared_releases shared
       WHERE shared.id = target_release_id
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

    CREATE OR REPLACE FUNCTION app.guard_conversation_pin() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE release_status text; active_release uuid; base_release uuid;
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.configuration_state = 'pinned' THEN
        SELECT status,base_shared_release_id INTO release_status,base_release FROM ai_releases
         WHERE tenant_id=NEW.tenant_id AND id=NEW.ai_release_id FOR SHARE;
        SELECT release_id INTO active_release FROM ai_release_activations WHERE tenant_id=NEW.tenant_id FOR SHARE;
        IF release_status IS DISTINCT FROM 'frozen' OR active_release IS DISTINCT FROM NEW.ai_release_id THEN
          RAISE EXCEPTION 'conversation pin must use the frozen active tenant release';
        END IF;
        IF base_release IS NOT NULL AND NOT app.lock_frozen_shared_release(base_release) THEN
          RAISE EXCEPTION 'conversation pin is based on a retired shared release';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' AND (
        OLD.configuration_state IS DISTINCT FROM NEW.configuration_state OR
        OLD.ai_release_id IS DISTINCT FROM NEW.ai_release_id
      ) THEN
        RAISE EXCEPTION 'conversation configuration pin is immutable';
      END IF;
      RETURN NEW;
    END $$;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.guard_conversation_pin() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE release_status text; active_release uuid; base_release uuid; base_status text;
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.configuration_state = 'pinned' THEN
        SELECT status,base_shared_release_id INTO release_status,base_release FROM ai_releases
         WHERE tenant_id=NEW.tenant_id AND id=NEW.ai_release_id FOR SHARE;
        SELECT release_id INTO active_release FROM ai_release_activations WHERE tenant_id=NEW.tenant_id FOR SHARE;
        IF release_status IS DISTINCT FROM 'frozen' OR active_release IS DISTINCT FROM NEW.ai_release_id THEN
          RAISE EXCEPTION 'conversation pin must use the frozen active tenant release';
        END IF;
        IF base_release IS NOT NULL THEN
          SELECT status INTO base_status FROM ai_shared_releases WHERE id=base_release FOR SHARE;
          IF base_status IS DISTINCT FROM 'frozen' THEN RAISE EXCEPTION 'conversation pin is based on a retired shared release'; END IF;
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' AND (
        OLD.configuration_state IS DISTINCT FROM NEW.configuration_state OR
        OLD.ai_release_id IS DISTINCT FROM NEW.ai_release_id
      ) THEN
        RAISE EXCEPTION 'conversation configuration pin is immutable';
      END IF;
      RETURN NEW;
    END $$;

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
