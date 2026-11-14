/**
 * KAN-34 (owner decision 2026-10-25): only the conversation owner changes the approved
 * deliverable; a tenant admin can only read.
 *
 * The approval trail (`deliverable_approvals`) and the stale marks already require
 * `user_id = approved_by/marked_by = app.current_user_id()` in their RLS INSERT policies, so a
 * tenant-admin context cannot write them. But the CURRENT approval lives in
 * `deliverables.selected_at` (and `superseded_by` on the replaced row), and the
 * `deliverables_access` policy lets a tenant-admin context (`app.is_tenant_admin = true`) update
 * any column. This trigger closes that gap: changing either column requires the session user to
 * be the deliverable's owner (`deliverables.user_id`, the conversation owner).
 *
 *  - Applies to every role, including the schema owner (no session user ⇒ rejected), so the only
 *    way to approve stays `approvalsRepo.approve` inside the owner's tenant transaction.
 *  - FK actions run nested inside the RI trigger (depth >= 2) and are allowed: deleting a
 *    deliverable still sets `superseded_by = NULL` on rows that pointed at it (ON DELETE SET NULL).
 *  - Inserts are untouched (`selected_at` starts NULL; workers insert as the owner).
 *  - Error code 42501 (insufficient_privilege), like an RLS refusal.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION app.guard_deliverable_approval_owner() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
      END IF;
      IF (NEW.selected_at IS DISTINCT FROM OLD.selected_at
          OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by)
         AND app.current_user_id() IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'only the conversation owner can change the approved deliverable'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END $$;

    CREATE TRIGGER deliverables_approval_owner_only
      BEFORE UPDATE OF selected_at, superseded_by ON deliverables
      FOR EACH ROW EXECUTE FUNCTION app.guard_deliverable_approval_owner();

    COMMENT ON TRIGGER deliverables_approval_owner_only ON deliverables IS
      'KAN-34: only the conversation owner changes selected_at / superseded_by (tenant admins read only).';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS deliverables_approval_owner_only ON deliverables;
    DROP FUNCTION IF EXISTS app.guard_deliverable_approval_owner();
  `);
};
