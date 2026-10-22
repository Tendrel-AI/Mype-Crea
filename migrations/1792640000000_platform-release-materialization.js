/**
 * KAN-77 forward repair: pin new conversations to the platform module release.
 *
 * KAN-71 resolves a new conversation's AI release as: organization module assignment,
 * else the tenant's active local release, else the global module default. The two
 * platform branches failed for every tenant user under RLS:
 *  1. `resolveNewConversationRelease` row-locked the shared release directly; under RLS
 *     `FOR SHARE` also applies the platform-only UPDATE policy, so no row was found.
 *  2. It then inserted the tenant-local copy as the conversation user; the ai_releases
 *     WITH CHECK requires a tenant admin, so ordinary members were rejected.
 *  3. The conversation-pin trigger accepted only the tenant's active local release, so a
 *     platform copy (which is not the activation) was always rejected.
 *
 * Instead of widening tenant INSERT/UPDATE policies or privileges, this migration adds:
 *  - app.effective_platform_ai_shared_release(uuid): internal resolver of the precedence
 *    above (returns the shared release id only when a platform branch applies). Not
 *    executable by app_user or PUBLIC; only the definer helpers below call it.
 *  - app.lock_effective_platform_ai_release(uuid): SECURITY DEFINER; requires an active
 *    member of the current tenant and that the requested shared release is that tenant's
 *    effective platform release; locks only that row FOR SHARE and returns only whether
 *    it is frozen.
 *  - app.materialize_platform_ai_release(uuid): SECURITY DEFINER; after the same check,
 *    copies exactly that frozen shared release into the current tenant as an immutable
 *    platform materialization (idempotent via ai_releases_platform_clone_unique) and
 *    returns only the tenant-local release id. The caller cannot choose the tenant, the
 *    content, the status, or any other release.
 *  - guard_conversation_pin also accepts a frozen platform materialization whose shared
 *    base is the tenant's effective platform release (checked and locked by the helper).
 *    Pins to the active local release keep the KAN-70 path unchanged.
 * Both helpers use a fixed search_path and row_security=off, revoke PUBLIC execute, and
 * grant execute only to app_user, matching app.lock_frozen_shared_release.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION app.effective_platform_ai_shared_release(target_tenant_id uuid)
    RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path = pg_catalog, public, app, pg_temp
    AS $$
    DECLARE assigned boolean; selected uuid;
    BEGIN
      SELECT true, module_version.shared_release_id INTO assigned, selected
        FROM public.platform_module_assignments assignment
        JOIN public.platform_module_versions module_version
          ON module_version.module_id = assignment.module_id AND module_version.version = assignment.version
       WHERE assignment.module_id = 'ai' AND assignment.organization_id = target_tenant_id;
      IF assigned THEN RETURN selected; END IF;
      IF EXISTS (
        SELECT 1
          FROM public.ai_release_activations activation
          JOIN public.ai_releases release
            ON release.tenant_id = activation.tenant_id AND release.id = activation.release_id
         WHERE activation.tenant_id = target_tenant_id AND release.status = 'frozen'
      ) THEN
        RETURN NULL;
      END IF;
      SELECT module_version.shared_release_id INTO selected
        FROM public.platform_module_defaults module_default
        JOIN public.platform_module_versions module_version
          ON module_version.module_id = module_default.module_id AND module_version.version = module_default.version
       WHERE module_default.module_id = 'ai';
      RETURN selected;
    END $$;
    REVOKE ALL ON FUNCTION app.effective_platform_ai_shared_release(uuid) FROM PUBLIC;

    CREATE FUNCTION app.lock_effective_platform_ai_release(target_release_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    DECLARE is_frozen boolean;
    BEGIN
      IF target_release_id IS NULL OR NOT app.has_active_member()
         OR app.effective_platform_ai_shared_release(app.current_tenant_id()) IS DISTINCT FROM target_release_id THEN
        RETURN false;
      END IF;
      SELECT shared.status = 'frozen' INTO is_frozen
        FROM public.ai_shared_releases shared
       WHERE shared.id = target_release_id
       FOR SHARE;
      RETURN COALESCE(is_frozen, false);
    END $$;
    REVOKE ALL ON FUNCTION app.lock_effective_platform_ai_release(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.lock_effective_platform_ai_release(uuid) TO app_user;

    CREATE FUNCTION app.materialize_platform_ai_release(target_release_id uuid)
    RETURNS uuid
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    DECLARE local_release uuid;
    BEGIN
      IF NOT app.lock_effective_platform_ai_release(target_release_id) THEN
        RETURN NULL;
      END IF;
      INSERT INTO public.ai_releases
        (tenant_id, name, status, draft_version, manifest, canonical_content, content_hash,
         base_shared_release_id, is_platform_materialization, allowed_override_paths,
         created_by, updated_by)
      SELECT app.current_tenant_id(), shared.name, 'frozen', 1, shared.manifest,
             shared.canonical_content, shared.content_hash, shared.id, true,
             shared.allowed_override_paths, app.current_user_id(), app.current_user_id()
        FROM public.ai_shared_releases shared
       WHERE shared.id = target_release_id
      ON CONFLICT DO NOTHING;
      SELECT release.id INTO local_release
        FROM public.ai_releases release
        JOIN public.ai_shared_releases shared ON shared.id = release.base_shared_release_id
       WHERE release.tenant_id = app.current_tenant_id()
         AND release.base_shared_release_id = target_release_id
         AND release.content_hash = shared.content_hash
         AND release.is_platform_materialization
         AND release.status = 'frozen'
       ORDER BY release.created_at, release.id
       LIMIT 1
       FOR SHARE OF release;
      RETURN local_release;
    END $$;
    REVOKE ALL ON FUNCTION app.materialize_platform_ai_release(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.materialize_platform_ai_release(uuid) TO app_user;

    CREATE OR REPLACE FUNCTION app.guard_conversation_pin() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE release_status text; active_release uuid; base_release uuid; platform_copy boolean;
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.configuration_state = 'pinned' THEN
        SELECT status,base_shared_release_id,is_platform_materialization
          INTO release_status,base_release,platform_copy FROM ai_releases
         WHERE tenant_id=NEW.tenant_id AND id=NEW.ai_release_id FOR SHARE;
        SELECT release_id INTO active_release FROM ai_release_activations WHERE tenant_id=NEW.tenant_id FOR SHARE;
        IF release_status IS DISTINCT FROM 'frozen' THEN
          RAISE EXCEPTION 'conversation pin must use the frozen active tenant release';
        END IF;
        IF active_release IS NOT DISTINCT FROM NEW.ai_release_id THEN
          IF base_release IS NOT NULL AND NOT app.lock_frozen_shared_release(base_release) THEN
            RAISE EXCEPTION 'conversation pin is based on a retired shared release';
          END IF;
        ELSIF NOT (platform_copy AND base_release IS NOT NULL
                   AND NEW.tenant_id = app.current_tenant_id()
                   AND app.lock_effective_platform_ai_release(base_release)) THEN
          RAISE EXCEPTION 'conversation pin must use the frozen active tenant release or the effective platform release';
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

    DROP FUNCTION IF EXISTS app.materialize_platform_ai_release(uuid);
    DROP FUNCTION IF EXISTS app.lock_effective_platform_ai_release(uuid);
    DROP FUNCTION IF EXISTS app.effective_platform_ai_shared_release(uuid);
  `);
};
