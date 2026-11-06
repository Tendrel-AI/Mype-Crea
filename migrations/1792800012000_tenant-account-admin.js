/**
 * KAN-41 (SYS-06): tenant-admin account management (decision KAN-66, Option B, approved
 * 2026-11-02).
 *
 * Design:
 *  - `users.status` is constrained to `active` / `inactive` (it was free text).
 *  - `users` writes move from "any tenant transaction" to "an active tenant admin only":
 *    the broad `users_tenant` policy is replaced by a tenant-axis SELECT policy plus admin-only
 *    INSERT (always a new active `member`) and UPDATE policies. Column grants narrow app_user to
 *    INSERT (tenant_id, workos_user_id, email, role, status) and UPDATE (status); no DELETE.
 *    Role changes and the first admin stay platform-operator actions (migration owner).
 *  - `tenant_account_audit_events` is the tenant-scoped, append-only admin trail: actor, action,
 *    target, before/after status, reason, outcome. `target_user_id` has no FK on purpose: a
 *    forged or cross-tenant id is exactly what a refused row records. Only an active tenant
 *    admin reads or writes it (members read none); app_user gets SELECT and a column INSERT
 *    without `id` / `created_at`, and no UPDATE/DELETE.
 */
// destructive-ok: drops the broad users_tenant policy for read + admin-only writes; no app code wrote users before KAN-41

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD CONSTRAINT users_status_valid CHECK (status IN ('active', 'inactive'));

    DROP POLICY users_tenant ON users;
    CREATE POLICY users_read ON users FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY users_admin_insert ON users FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND app.has_tenant_admin()
        AND role = 'member'
        AND status = 'active'
      );
    CREATE POLICY users_admin_update ON users FOR UPDATE
      USING (tenant_id = app.current_tenant_id() AND app.has_tenant_admin())
      WITH CHECK (tenant_id = app.current_tenant_id());

    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON users FROM app_user;
    GRANT INSERT (tenant_id, workos_user_id, email, role, status) ON users TO app_user;
    GRANT UPDATE (status) ON users TO app_user;

    CREATE TABLE tenant_account_audit_events (
      id             uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid        NOT NULL,
      actor_user_id  uuid        NOT NULL,
      action         text        NOT NULL CHECK (action IN ('member.provision', 'member.deactivate', 'member.reactivate')),
      target_user_id uuid,
      target_email   citext      CHECK (char_length(target_email) <= 254),
      before_status  text        CHECK (before_status IN ('active', 'inactive')),
      after_status   text        CHECK (after_status IN ('active', 'inactive')),
      reason         text        CHECK (char_length(reason) <= 500),
      outcome        text        NOT NULL CHECK (outcome IN ('success', 'refused', 'failed')),
      outcome_code   text        CHECK (outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      created_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      CHECK ((outcome = 'success') = (outcome_code IS NULL))
    );

    CREATE INDEX tenant_account_audit_tenant_created ON tenant_account_audit_events (tenant_id, created_at DESC);

    ALTER TABLE tenant_account_audit_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_account_audit_events FORCE  ROW LEVEL SECURITY;

    CREATE POLICY tenant_account_audit_read ON tenant_account_audit_events FOR SELECT
      USING (tenant_id = app.current_tenant_id() AND app.has_tenant_admin());
    CREATE POLICY tenant_account_audit_insert ON tenant_account_audit_events FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND actor_user_id = app.current_user_id()
        AND app.has_tenant_admin()
      );

    GRANT SELECT ON tenant_account_audit_events TO app_user;
    GRANT INSERT (tenant_id, actor_user_id, action, target_user_id, target_email, before_status, after_status, reason, outcome, outcome_code)
      ON tenant_account_audit_events TO app_user;

    COMMENT ON TABLE tenant_account_audit_events IS
      'KAN-41: append-only tenant-admin account operations (provision, deactivate, reactivate) with outcome; server-timestamped.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tenant_account_audit_events;
    DROP POLICY IF EXISTS users_read ON users;
    DROP POLICY IF EXISTS users_admin_insert ON users;
    DROP POLICY IF EXISTS users_admin_update ON users;
    CREATE POLICY users_tenant ON users USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
    GRANT INSERT, UPDATE, DELETE ON users TO app_user;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_valid;
  `);
};
