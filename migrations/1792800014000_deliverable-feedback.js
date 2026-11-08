/**
 * Prompt ledger (step 4): thumbs up/down on a generated deliverable version (F13 / D21).
 *
 *  - `deliverable_feedback`: one row per (deliverable, rater). Tenant + owner scoped by RLS: a user
 *    only sees and writes their own rating, and only on their own deliverables. Never sent to LangSmith.
 *  - `prompt_version` is copied by the repo from `deliverables.artifact_metadata->>'promptVersion'`
 *    at write time (never from the client); NULL when the deliverable recorded none.
 *  - `app.prompt_ledger_feedback(p_version)` (SECURITY DEFINER, row_security off, same posture as the
 *    other prompt-ledger functions) is the developer-only cross-tenant read (F14 / D19): deliverable
 *    id, an opaque sha256 of the rater id, value and time. No tenant id, no content. EXECUTE is
 *    revoked from PUBLIC and app_user, so only the owner role (the CLI) can call it.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE deliverable_feedback (
      tenant_id      uuid        NOT NULL,
      deliverable_id uuid        NOT NULL,
      user_id        uuid        NOT NULL,
      value          text        NOT NULL CHECK (value IN ('up', 'down')),
      prompt_version text        CHECK (prompt_version IS NULL OR btrim(prompt_version) <> ''),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, deliverable_id, user_id),
      FOREIGN KEY (tenant_id, deliverable_id) REFERENCES deliverables(tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, user_id)        REFERENCES users(tenant_id, id)        ON DELETE CASCADE
    );
    CREATE INDEX deliverable_feedback_tenant_user ON deliverable_feedback (tenant_id, user_id, updated_at);
    CREATE INDEX deliverable_feedback_version ON deliverable_feedback (prompt_version);

    ALTER TABLE deliverable_feedback ENABLE ROW LEVEL SECURITY;
    ALTER TABLE deliverable_feedback FORCE  ROW LEVEL SECURITY;

    -- Owner only (no admin bypass): the deliverable must belong to the current user.
    CREATE POLICY deliverable_feedback_owner ON deliverable_feedback
      USING (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND EXISTS (SELECT 1 FROM deliverables d
                     WHERE d.tenant_id = deliverable_feedback.tenant_id
                       AND d.id = deliverable_feedback.deliverable_id
                       AND d.user_id = app.current_user_id())
      )
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND app.has_active_member()
        AND EXISTS (SELECT 1 FROM deliverables d
                     WHERE d.tenant_id = deliverable_feedback.tenant_id
                       AND d.id = deliverable_feedback.deliverable_id
                       AND d.user_id = app.current_user_id())
      );

    GRANT SELECT, INSERT, UPDATE, DELETE ON deliverable_feedback TO app_user;

    CREATE FUNCTION app.prompt_ledger_feedback(p_version text)
    RETURNS TABLE (subject_id uuid, rater_hash text, value text, updated_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, app
    SET row_security = off
    AS $fn$
      SELECT f.deliverable_id, encode(sha256(convert_to(f.user_id::text, 'UTF8')), 'hex'), f.value, f.updated_at
        FROM public.deliverable_feedback f
       WHERE f.prompt_version = p_version
       ORDER BY f.updated_at, f.deliverable_id
    $fn$;

    REVOKE ALL ON FUNCTION app.prompt_ledger_feedback(text) FROM PUBLIC, app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS app.prompt_ledger_feedback(text);
    DROP TABLE IF EXISTS deliverable_feedback;
  `);
};
