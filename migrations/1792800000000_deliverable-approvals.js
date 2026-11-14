/**
 * KAN-34 (RF-06) / KAN-65 decision A + R2: approval history and staleness marks.
 *
 * Design:
 *  - «Aprobar» is one explicit act per deliverable kind. The current approved deliverable stays
 *    `deliverables.selected_at IS NOT NULL`, guarded by the existing partial unique index
 *    `deliverables_selected_per_kind` (one per conversation and kind). `superseded_by` now means
 *    "replaced as approved by" (KAN-65). The repository keeps both columns consistent inside the
 *    approval transaction; this migration does not replace that mechanism.
 *  - `deliverable_approvals` is the append-only trail (KAN-34 AC4, RNF-04): one row per approval
 *    or replacement, with the replaced deliverable. Composite FKs bind every referenced
 *    deliverable to the same tenant, conversation and kind (new UNIQUE on deliverables), and the
 *    conversation owner (`user_id`) to the conversation, so a row cannot point across tenants,
 *    conversations or kinds.
 *  - `deliverable_stale_marks` records RF-07/KAN-35 staleness per kind as append-only events.
 *    Nothing is ever regenerated. A kind is stale when its newest mark has a higher `event_seq`
 *    than its newest approval: a later approval clears it without deleting anything, so the
 *    state stays a pure function of rows and the trail is kept.
 *  - Both tables draw `event_seq` from one shared sequence, assigned by a BEFORE INSERT trigger
 *    (client values are overwritten), together with the server timestamp. Writers hold the
 *    conversation row lock, so within a conversation the sequence order is the commit order.
 *  - Append-only: app_user gets SELECT and INSERT only; RLS has only SELECT and INSERT policies;
 *    a trigger rejects every UPDATE and any DELETE that is not an FK cascade (deleting the
 *    conversation, task or deliverable still cascades, so retention deletes keep working).
 *  - RLS: tenant + conversation owner. Owners and tenant admins read; only the active owner of
 *    the conversation inserts, as themselves (`approved_by`/`marked_by` = current user).
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE deliverables
      ADD CONSTRAINT deliverables_tenant_id_conversation_kind_unique
        UNIQUE (tenant_id, id, conversation_id, kind);

    CREATE SEQUENCE deliverable_event_seq AS bigint;

    CREATE TABLE deliverable_approvals (
      id                      uuid             NOT NULL DEFAULT gen_random_uuid(),
      tenant_id               uuid             NOT NULL,
      conversation_id         uuid             NOT NULL,
      user_id                 uuid             NOT NULL,
      deliverable_kind        deliverable_kind NOT NULL,
      deliverable_id          uuid             NOT NULL,
      replaced_deliverable_id uuid,
      approved_by             uuid             NOT NULL,
      approved_at             timestamptz      NOT NULL DEFAULT now(),
      event_seq               bigint           NOT NULL DEFAULT nextval('deliverable_event_seq'),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (event_seq),
      FOREIGN KEY (tenant_id, conversation_id, user_id)
        REFERENCES conversations(tenant_id, id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, deliverable_id, conversation_id, deliverable_kind)
        REFERENCES deliverables(tenant_id, id, conversation_id, kind) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, replaced_deliverable_id, conversation_id, deliverable_kind)
        REFERENCES deliverables(tenant_id, id, conversation_id, kind) ON DELETE CASCADE,
      CHECK (replaced_deliverable_id IS DISTINCT FROM deliverable_id)
    );

    CREATE TABLE deliverable_stale_marks (
      id               uuid             NOT NULL DEFAULT gen_random_uuid(),
      tenant_id        uuid             NOT NULL,
      conversation_id  uuid             NOT NULL,
      user_id          uuid             NOT NULL,
      deliverable_kind deliverable_kind NOT NULL,
      marked_by        uuid             NOT NULL,
      marked_at        timestamptz      NOT NULL DEFAULT now(),
      event_seq        bigint           NOT NULL DEFAULT nextval('deliverable_event_seq'),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (event_seq),
      FOREIGN KEY (tenant_id, conversation_id, user_id)
        REFERENCES conversations(tenant_id, id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, marked_by) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
    );

    CREATE INDEX deliverable_approvals_tenant_conversation_kind
      ON deliverable_approvals (tenant_id, conversation_id, deliverable_kind, event_seq DESC);
    CREATE INDEX deliverable_stale_marks_tenant_conversation_kind
      ON deliverable_stale_marks (tenant_id, conversation_id, deliverable_kind, event_seq DESC);

    CREATE OR REPLACE FUNCTION app.guard_deliverable_event() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.event_seq := nextval('public.deliverable_event_seq');
        IF TG_TABLE_NAME = 'deliverable_approvals' THEN
          NEW.approved_at := now();
        ELSE
          NEW.marked_at := now();
        END IF;
        RETURN NEW;
      END IF;
      -- FK cascades run nested inside the RI trigger (depth >= 2); a direct DELETE runs at
      -- depth 1 and is rejected, as is every UPDATE.
      IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
    END $$;

    CREATE TRIGGER deliverable_approvals_append_only
      BEFORE INSERT OR UPDATE OR DELETE ON deliverable_approvals
      FOR EACH ROW EXECUTE FUNCTION app.guard_deliverable_event();
    CREATE TRIGGER deliverable_stale_marks_append_only
      BEFORE INSERT OR UPDATE OR DELETE ON deliverable_stale_marks
      FOR EACH ROW EXECUTE FUNCTION app.guard_deliverable_event();

    ALTER TABLE deliverable_approvals   ENABLE ROW LEVEL SECURITY;
    ALTER TABLE deliverable_approvals   FORCE  ROW LEVEL SECURITY;
    ALTER TABLE deliverable_stale_marks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE deliverable_stale_marks FORCE  ROW LEVEL SECURITY;

    CREATE POLICY deliverable_approvals_read ON deliverable_approvals FOR SELECT
      USING (
        tenant_id = app.current_tenant_id()
        AND (app.is_tenant_admin() OR user_id = app.current_user_id())
      );
    CREATE POLICY deliverable_approvals_insert ON deliverable_approvals FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND approved_by = app.current_user_id()
        AND app.has_active_member()
      );

    CREATE POLICY deliverable_stale_marks_read ON deliverable_stale_marks FOR SELECT
      USING (
        tenant_id = app.current_tenant_id()
        AND (app.is_tenant_admin() OR user_id = app.current_user_id())
      );
    CREATE POLICY deliverable_stale_marks_insert ON deliverable_stale_marks FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND marked_by = app.current_user_id()
        AND app.has_active_member()
      );

    GRANT SELECT, INSERT ON deliverable_approvals, deliverable_stale_marks TO app_user;
    GRANT USAGE ON SEQUENCE deliverable_event_seq TO app_user;

    COMMENT ON TABLE deliverable_approvals IS
      'KAN-34/KAN-65: append-only approval and replacement trail. The current approval is deliverables.selected_at.';
    COMMENT ON TABLE deliverable_stale_marks IS
      'KAN-34/KAN-35: append-only staleness marks per kind; a later approval of the kind (higher event_seq) clears it.';
    COMMENT ON COLUMN deliverables.superseded_by IS
      'KAN-65: the deliverable that replaced this one as the approved deliverable of its kind.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS deliverable_stale_marks;
    DROP TABLE IF EXISTS deliverable_approvals;
    DROP FUNCTION IF EXISTS app.guard_deliverable_event();
    DROP SEQUENCE IF EXISTS deliverable_event_seq;
    COMMENT ON COLUMN deliverables.superseded_by IS NULL;
    ALTER TABLE deliverables DROP CONSTRAINT IF EXISTS deliverables_tenant_id_conversation_kind_unique;
  `);
};
