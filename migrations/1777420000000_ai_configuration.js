/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT coalesce(current_setting('app.is_platform_admin', true) = 'true', false)
    $$;

    CREATE OR REPLACE FUNCTION app.has_active_member() RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.tenant_id = app.current_tenant_id()
           AND u.id = app.current_user_id()
           AND u.status = 'active'
      )
    $$;

    CREATE OR REPLACE FUNCTION app.has_tenant_admin() RETURNS boolean
    LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.tenant_id = app.current_tenant_id()
           AND u.id = app.current_user_id()
           AND u.status = 'active'
           AND u.role = 'admin'
      )
    $$;

    GRANT EXECUTE ON FUNCTION app.is_platform_admin(), app.has_active_member(), app.has_tenant_admin() TO app_user;

    CREATE OR REPLACE FUNCTION app.canonical_json(value jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT AS $$
    DECLARE result text;
    BEGIN
      CASE jsonb_typeof(value)
        WHEN 'object' THEN
          SELECT '{' || COALESCE(string_agg(to_json(key)::text || ':' || app.canonical_json(item), ',' ORDER BY key COLLATE "C"), '') || '}'
            INTO result FROM jsonb_each(value) AS pairs(key,item);
          RETURN result;
        WHEN 'array' THEN
          SELECT '[' || COALESCE(string_agg(app.canonical_json(item), ',' ORDER BY ordinal), '') || ']'
            INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ordinal);
          RETURN result;
        WHEN 'number' THEN
          RETURN trim_scale(value::text::numeric)::text;
        ELSE
          RETURN value::text;
      END CASE;
    END $$;
    GRANT EXECUTE ON FUNCTION app.canonical_json(jsonb) TO app_user;

    CREATE TABLE ai_shared_releases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'retired')),
      draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version > 0),
      manifest jsonb NOT NULL,
      canonical_content text NOT NULL,
      content_hash text,
      allowed_override_paths text[] NOT NULL DEFAULT '{}',
      created_by_workos_user_id text NOT NULL,
      updated_by_workos_user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      frozen_at timestamptz,
      retired_at timestamptz,
      CHECK ((status = 'draft') OR content_hash IS NOT NULL),
      CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
    );

    CREATE TABLE ai_releases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'retired')),
      draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version > 0),
      manifest jsonb NOT NULL,
      canonical_content text NOT NULL,
      content_hash text,
      base_shared_release_id uuid REFERENCES ai_shared_releases(id) ON DELETE RESTRICT,
      allowed_override_paths text[] NOT NULL DEFAULT '{}',
      created_by uuid NOT NULL,
      updated_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      frozen_at timestamptz,
      retired_at timestamptz,
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      CHECK ((status = 'draft') OR content_hash IS NOT NULL),
      CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
    );

    CREATE TABLE ai_release_activations (
      tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      release_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      updated_by uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, release_id) REFERENCES ai_releases(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE ai_config_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_user_id uuid NOT NULL,
      action text NOT NULL,
      release_id uuid,
      shared_release_id uuid REFERENCES ai_shared_releases(id) ON DELETE RESTRICT,
      previous_version integer,
      new_version integer,
      content_hash text,
      metadata jsonb NOT NULL DEFAULT '{}',
      occurred_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, release_id) REFERENCES ai_releases(tenant_id, id) ON DELETE RESTRICT,
      CHECK (release_id IS NULL OR shared_release_id IS NULL),
      CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
    );

    CREATE TABLE ai_provider_availability (
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider text NOT NULL CHECK (provider IN ('openrouter', 'anthropic')),
      enabled boolean NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      updated_by uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, provider),
      FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
    );

    ALTER TABLE conversations
      ADD COLUMN ai_release_id uuid,
      ADD COLUMN configuration_state text NOT NULL DEFAULT 'legacy_unversioned';
    ALTER TABLE conversations ADD CONSTRAINT conversations_configuration_state_check
      CHECK (
        (configuration_state = 'legacy_unversioned' AND ai_release_id IS NULL)
        OR (configuration_state = 'pinned' AND ai_release_id IS NOT NULL)
      );
    ALTER TABLE conversations ADD CONSTRAINT conversations_ai_release_fk
      FOREIGN KEY (tenant_id, ai_release_id) REFERENCES ai_releases(tenant_id, id) ON DELETE RESTRICT;
    ALTER TABLE conversations ADD CONSTRAINT conversations_tenant_id_user_release_unique
      UNIQUE (tenant_id,id,user_id,ai_release_id);

    ALTER TABLE messages ADD COLUMN ai_turn_id uuid;

    CREATE TABLE ai_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      release_id uuid NOT NULL,
      request_id uuid NOT NULL,
      input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
      input_content text,
      response_content text,
      stage text NOT NULL CHECK (stage IN ('reserved', 'extracted', 'effects_started', 'effects_committed', 'responded', 'uncertain')),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      owner_token uuid,
      lease_expires_at timestamptz,
      payload jsonb NOT NULL DEFAULT '{}',
      failure_category text,
      recoverable boolean,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, conversation_id, request_id),
      UNIQUE (tenant_id,id,user_id,conversation_id,release_id),
      UNIQUE (tenant_id,id,user_id,conversation_id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, conversation_id, user_id, release_id) REFERENCES conversations(tenant_id,id,user_id,ai_release_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, release_id) REFERENCES ai_releases(tenant_id, id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX ai_turns_one_open_per_conversation
      ON ai_turns (tenant_id, conversation_id) WHERE stage <> 'responded';

    CREATE TABLE ai_turn_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      turn_id uuid NOT NULL,
      release_id uuid NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('extractor', 'responder')),
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      primary_profile_id text NOT NULL,
      effective_profile_id text NOT NULL,
      provider text NOT NULL CHECK (provider IN ('openrouter', 'anthropic')),
      model text NOT NULL,
      model_revision text,
      status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'uncertain')),
      failure_category text,
      request_content text,
      response_content text,
      input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
      output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
      latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
      cost_amount numeric(14, 8) CHECK (cost_amount IS NULL OR cost_amount >= 0),
      cost_currency text,
      cost_source text CHECK (cost_source IS NULL OR cost_source IN ('provider_reported', 'estimated')),
      pricing_version text,
      provider_status integer,
      total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
      cache_read_tokens integer CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      reasoning_tokens integer CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, turn_id, purpose, attempt_number),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, turn_id,user_id,conversation_id,release_id) REFERENCES ai_turns(tenant_id,id,user_id,conversation_id,release_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, release_id) REFERENCES ai_releases(tenant_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE ai_turn_notices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      turn_id uuid NOT NULL,
      code text NOT NULL,
      content text,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, turn_id,user_id,conversation_id) REFERENCES ai_turns(tenant_id,id,user_id,conversation_id) ON DELETE CASCADE
    );

    CREATE TABLE ai_turn_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      turn_id uuid,
      task_id uuid NOT NULL,
      event_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('artifact', 'task_processing', 'decision', 'notice')),
      payload jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      acknowledged_at timestamptz,
      UNIQUE (tenant_id, event_id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, conversation_id,user_id) REFERENCES conversations(tenant_id,id,user_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, turn_id) REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, task_id) REFERENCES agent_tasks(tenant_id, id) ON DELETE CASCADE
    );

    CREATE INDEX ai_releases_tenant_status ON ai_releases (tenant_id, status, updated_at DESC);
    CREATE INDEX ai_release_audit_tenant_time ON ai_config_audit_events (tenant_id, occurred_at DESC);
    CREATE INDEX ai_turns_tenant_conversation_created ON ai_turns (tenant_id, conversation_id, created_at DESC);
    CREATE INDEX ai_turn_attempts_tenant_turn ON ai_turn_attempts (tenant_id, turn_id, started_at);
    CREATE INDEX ai_turn_notices_tenant_turn ON ai_turn_notices (tenant_id, turn_id, created_at);
    CREATE INDEX ai_turn_events_tenant_conversation_created ON ai_turn_events (tenant_id, conversation_id, created_at, id);
    CREATE INDEX ai_shared_releases_status ON ai_shared_releases (status, updated_at DESC);
    ALTER TABLE messages ADD CONSTRAINT messages_ai_turn_fk FOREIGN KEY (tenant_id, ai_turn_id,user_id,conversation_id) REFERENCES ai_turns(tenant_id,id,user_id,conversation_id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX messages_one_per_turn_role ON messages(tenant_id,ai_turn_id,role) WHERE ai_turn_id IS NOT NULL;

    ALTER TABLE ai_shared_releases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_shared_releases FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_releases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_releases FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_release_activations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_release_activations FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_config_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_config_audit_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_provider_availability ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_provider_availability FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_turns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_turns FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_turn_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_turn_attempts FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_turn_notices ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_turn_notices FORCE ROW LEVEL SECURITY;
    ALTER TABLE ai_turn_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ai_turn_events FORCE ROW LEVEL SECURITY;
    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE messages FORCE ROW LEVEL SECURITY;

    CREATE POLICY ai_shared_releases_read ON ai_shared_releases FOR SELECT
      USING (app.has_active_member() AND (app.is_platform_admin() OR app.has_tenant_admin()));
    CREATE POLICY ai_shared_releases_insert ON ai_shared_releases FOR INSERT
      WITH CHECK (app.has_active_member() AND app.is_platform_admin());
    CREATE POLICY ai_shared_releases_update ON ai_shared_releases FOR UPDATE
      USING (app.has_active_member() AND app.is_platform_admin()) WITH CHECK (app.has_active_member() AND app.is_platform_admin());

    CREATE POLICY ai_releases_access ON ai_releases
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member())
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_admin());
    CREATE POLICY ai_release_activations_access ON ai_release_activations
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member())
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_admin());
    CREATE POLICY ai_config_audit_read ON ai_config_audit_events FOR SELECT
      USING (tenant_id = app.current_tenant_id() AND (actor_user_id = app.current_user_id() OR app.has_tenant_admin() OR app.is_platform_admin()));
    CREATE POLICY ai_config_audit_insert ON ai_config_audit_events FOR INSERT
      WITH CHECK (tenant_id = app.current_tenant_id() AND actor_user_id = app.current_user_id() AND (app.has_tenant_admin() OR app.is_platform_admin()));
    CREATE POLICY ai_provider_availability_access ON ai_provider_availability
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member())
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_admin());
    CREATE POLICY ai_turns_access ON ai_turns
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member() AND (user_id = app.current_user_id() OR app.has_tenant_admin()))
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_active_member() AND user_id = app.current_user_id());
    CREATE POLICY ai_turn_attempts_access ON ai_turn_attempts
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member() AND (user_id = app.current_user_id() OR app.has_tenant_admin()))
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_active_member() AND user_id = app.current_user_id());
    CREATE POLICY ai_turn_notices_access ON ai_turn_notices
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member() AND (user_id = app.current_user_id() OR app.has_tenant_admin()))
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_active_member() AND user_id = app.current_user_id());
    CREATE POLICY ai_turn_events_access ON ai_turn_events
      USING (tenant_id = app.current_tenant_id() AND app.has_active_member() AND (user_id = app.current_user_id() OR app.has_tenant_admin()))
      WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_active_member() AND user_id = app.current_user_id());

    GRANT SELECT, INSERT, UPDATE ON ai_shared_releases TO app_user;
    GRANT SELECT, INSERT, UPDATE ON ai_releases, ai_release_activations, ai_provider_availability TO app_user;
    GRANT SELECT, INSERT ON ai_config_audit_events TO app_user;
    GRANT SELECT, INSERT, UPDATE ON ai_turns, ai_turn_attempts, ai_turn_notices, ai_turn_events TO app_user;

    CREATE OR REPLACE FUNCTION app.validate_frozen_manifest() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IN ('frozen', 'retired') THEN
        IF NEW.content_hash IS NULL
           OR NEW.canonical_content IS DISTINCT FROM app.canonical_json(NEW.manifest)
           OR encode(digest(NEW.canonical_content, 'sha256'), 'hex') <> NEW.content_hash THEN
          RAISE EXCEPTION 'frozen manifest canonical content or SHA-256 hash is invalid';
        END IF;
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION app.guard_shared_release_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'platform admin required'; END IF;
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'shared releases are retained'; END IF;
      IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
        IF NOT (OLD.status = 'frozen' AND NEW.status = 'retired'
          AND NEW.name = OLD.name AND NEW.manifest = OLD.manifest
          AND NEW.canonical_content = OLD.canonical_content AND NEW.content_hash = OLD.content_hash
          AND NEW.allowed_override_paths = OLD.allowed_override_paths
          AND NEW.draft_version = OLD.draft_version
          AND NEW.created_by_workos_user_id = OLD.created_by_workos_user_id) THEN
          RAISE EXCEPTION 'frozen shared release is immutable';
        END IF;
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION app.guard_tenant_release_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'tenant releases are retained'; END IF;
      IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
        IF NOT (OLD.status = 'frozen' AND NEW.status = 'retired'
          AND NEW.tenant_id = OLD.tenant_id AND NEW.name = OLD.name
          AND NEW.manifest = OLD.manifest AND NEW.canonical_content = OLD.canonical_content
          AND NEW.content_hash = OLD.content_hash
          AND NEW.base_shared_release_id IS NOT DISTINCT FROM OLD.base_shared_release_id
          AND NEW.allowed_override_paths = OLD.allowed_override_paths
          AND NEW.draft_version = OLD.draft_version
          AND NEW.created_by = OLD.created_by) THEN
          RAISE EXCEPTION 'frozen tenant release is immutable';
        END IF;
        IF EXISTS (SELECT 1 FROM ai_release_activations a WHERE a.tenant_id = OLD.tenant_id AND a.release_id = OLD.id) THEN
          RAISE EXCEPTION 'active release must be replaced before retirement';
        END IF;
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

    CREATE OR REPLACE FUNCTION app.guard_turn_transition() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.stage = 'uncertain' AND NEW.stage <> 'uncertain' THEN
        RAISE EXCEPTION 'uncertain turn requires explicit recovery';
      END IF;
      IF OLD.stage = 'responded' AND NEW.stage <> 'responded' THEN
        RAISE EXCEPTION 'completed turn is immutable';
      END IF;
      IF NEW.stage = 'uncertain' THEN RETURN NEW; END IF;
      IF NEW.stage <> OLD.stage AND NOT (
        (OLD.stage = 'reserved' AND NEW.stage = 'extracted') OR
        (OLD.stage = 'extracted' AND NEW.stage IN ('effects_started', 'effects_committed')) OR
        (OLD.stage = 'effects_started' AND NEW.stage = 'effects_committed') OR
        (OLD.stage = 'effects_committed' AND NEW.stage = 'responded')
      ) THEN RAISE EXCEPTION 'invalid turn stage transition'; END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION app.guard_turn_event_owner() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE conversation_owner uuid;
    BEGIN
      SELECT user_id INTO conversation_owner FROM conversations
       WHERE tenant_id = NEW.tenant_id AND id = NEW.conversation_id;
      IF NOT FOUND OR conversation_owner <> NEW.user_id THEN RAISE EXCEPTION 'event owner does not own conversation'; END IF;
      IF NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.task_id AND t.conversation_id = NEW.conversation_id) THEN
        RAISE EXCEPTION 'event task does not belong to conversation';
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE FUNCTION app.guard_audit_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'AI configuration audit events are append-only'; END $$;

    CREATE OR REPLACE FUNCTION app.scrub_ai_turn_trace(target_turn_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
    DECLARE turn_row public.ai_turns%ROWTYPE;
    BEGIN
      IF NOT app.has_active_member() OR NOT app.has_tenant_admin() THEN RETURN false; END IF;
      SELECT * INTO turn_row FROM public.ai_turns
       WHERE tenant_id=app.current_tenant_id() AND id=target_turn_id FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      IF turn_row.stage NOT IN ('responded','uncertain') THEN
        RAISE EXCEPTION 'active or recoverable turn content cannot be scrubbed';
      END IF;
      UPDATE public.ai_turns SET input_content=NULL,response_content=NULL,payload='{}'::jsonb,updated_at=now()
       WHERE tenant_id=app.current_tenant_id() AND id=target_turn_id;
      UPDATE public.ai_turn_attempts SET request_content=NULL,response_content=NULL
       WHERE tenant_id=app.current_tenant_id() AND turn_id=target_turn_id;
      UPDATE public.ai_turn_notices SET content=NULL
       WHERE tenant_id=app.current_tenant_id() AND turn_id=target_turn_id;
      UPDATE public.ai_turn_events SET payload=payload-'artifacts'
       WHERE tenant_id=app.current_tenant_id() AND turn_id=target_turn_id;
      UPDATE public.messages SET content=''
       WHERE tenant_id=app.current_tenant_id() AND ai_turn_id=target_turn_id;
      INSERT INTO public.ai_config_audit_events(tenant_id,actor_user_id,action,metadata)
       VALUES(app.current_tenant_id(),app.current_user_id(),'trace_content_scrubbed',
              jsonb_build_object('turn_id',target_turn_id,'turn_owner_id',turn_row.user_id));
      RETURN true;
    END $$;
    REVOKE ALL ON FUNCTION app.scrub_ai_turn_trace(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.scrub_ai_turn_trace(uuid) TO app_user;

    CREATE TRIGGER ai_shared_releases_hash_check BEFORE INSERT OR UPDATE ON ai_shared_releases
      FOR EACH ROW EXECUTE FUNCTION app.validate_frozen_manifest();
    CREATE TRIGGER ai_releases_hash_check BEFORE INSERT OR UPDATE ON ai_releases
      FOR EACH ROW EXECUTE FUNCTION app.validate_frozen_manifest();
    CREATE TRIGGER ai_shared_releases_immutable BEFORE UPDATE OR DELETE ON ai_shared_releases
      FOR EACH ROW EXECUTE FUNCTION app.guard_shared_release_mutation();
    CREATE TRIGGER ai_releases_immutable BEFORE UPDATE OR DELETE ON ai_releases
      FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_release_mutation();
    CREATE TRIGGER ai_release_activations_frozen BEFORE INSERT OR UPDATE ON ai_release_activations
      FOR EACH ROW EXECUTE FUNCTION app.guard_release_activation();
    CREATE TRIGGER conversations_pin_immutable BEFORE INSERT OR UPDATE ON conversations
      FOR EACH ROW EXECUTE FUNCTION app.guard_conversation_pin();
    CREATE TRIGGER ai_turn_stage_transition BEFORE UPDATE ON ai_turns
      FOR EACH ROW EXECUTE FUNCTION app.guard_turn_transition();
    CREATE TRIGGER ai_turn_events_owner_check BEFORE INSERT ON ai_turn_events
      FOR EACH ROW EXECUTE FUNCTION app.guard_turn_event_owner();
    CREATE TRIGGER ai_config_audit_append_only BEFORE UPDATE OR DELETE ON ai_config_audit_events
      FOR EACH ROW EXECUTE FUNCTION app.guard_audit_append_only();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS ai_config_audit_append_only ON ai_config_audit_events;
    DROP TRIGGER IF EXISTS ai_turn_events_owner_check ON ai_turn_events;
    DROP TRIGGER IF EXISTS ai_turn_stage_transition ON ai_turns;
    DROP TRIGGER IF EXISTS conversations_pin_immutable ON conversations;
    DROP TRIGGER IF EXISTS ai_release_activations_frozen ON ai_release_activations;
    DROP TRIGGER IF EXISTS ai_releases_immutable ON ai_releases;
    DROP TRIGGER IF EXISTS ai_shared_releases_immutable ON ai_shared_releases;
    DROP TRIGGER IF EXISTS ai_releases_hash_check ON ai_releases;
    DROP TRIGGER IF EXISTS ai_shared_releases_hash_check ON ai_shared_releases;

    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_turn_fk;
    DROP INDEX IF EXISTS messages_one_per_turn_role;
    ALTER TABLE messages DROP COLUMN IF EXISTS ai_turn_id;

    DROP TABLE IF EXISTS ai_turn_events;
    DROP TABLE IF EXISTS ai_turn_notices;
    DROP TABLE IF EXISTS ai_turn_attempts;
    DROP TABLE IF EXISTS ai_turns;

    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_ai_release_fk;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_id_user_release_unique;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_configuration_state_check;
    ALTER TABLE conversations DROP COLUMN IF EXISTS configuration_state;
    ALTER TABLE conversations DROP COLUMN IF EXISTS ai_release_id;

    DROP TABLE IF EXISTS ai_provider_availability;
    DROP TABLE IF EXISTS ai_config_audit_events;
    DROP TABLE IF EXISTS ai_release_activations;
    DROP TABLE IF EXISTS ai_releases;
    DROP TABLE IF EXISTS ai_shared_releases;

    DROP FUNCTION IF EXISTS app.guard_audit_append_only();
    DROP FUNCTION IF EXISTS app.scrub_ai_turn_trace(uuid);
    DROP FUNCTION IF EXISTS app.guard_turn_event_owner();
    DROP FUNCTION IF EXISTS app.guard_turn_transition();
    DROP FUNCTION IF EXISTS app.guard_conversation_pin();
    DROP FUNCTION IF EXISTS app.guard_release_activation();
    DROP FUNCTION IF EXISTS app.guard_tenant_release_mutation();
    DROP FUNCTION IF EXISTS app.guard_shared_release_mutation();
    DROP FUNCTION IF EXISTS app.validate_frozen_manifest();
    DROP FUNCTION IF EXISTS app.canonical_json(jsonb);
    DROP FUNCTION IF EXISTS app.has_tenant_admin();
    DROP FUNCTION IF EXISTS app.has_active_member();
    DROP FUNCTION IF EXISTS app.is_platform_admin();

    GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id(), app.is_tenant_admin() TO app_user;
  `);
};
