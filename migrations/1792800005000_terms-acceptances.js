/**
 * KAN-27 (SYS-02): informed-consent acceptance per user and terms version.
 *
 * Design:
 *  - One row per (tenant, user, terms version): the evidence that this user explicitly accepted
 *    that version. Re-accepting the same version is a no-op (UNIQUE); a new version needs a new row.
 *  - Append-only: app_user gets SELECT and a column-level INSERT on (tenant_id, user_id,
 *    terms_version) only, so the server clock (`accepted_at DEFAULT now()`) and the id can never
 *    come from a request. No UPDATE/DELETE grant or policy.
 *  - RLS: tenant + owner. A user reads and inserts only their own rows, as an active member;
 *    tenant admins may read their tenant's rows (consent evidence), never write them.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE terms_acceptances (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL,
      user_id       uuid        NOT NULL,
      terms_version text        NOT NULL CHECK (terms_version ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
      accepted_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, user_id, terms_version),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
    );

    ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;
    ALTER TABLE terms_acceptances FORCE  ROW LEVEL SECURITY;

    CREATE POLICY terms_acceptances_read ON terms_acceptances FOR SELECT
      USING (
        tenant_id = app.current_tenant_id()
        AND (app.is_tenant_admin() OR user_id = app.current_user_id())
      );
    CREATE POLICY terms_acceptances_insert ON terms_acceptances FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND app.has_active_member()
      );

    GRANT SELECT ON terms_acceptances TO app_user;
    GRANT INSERT (tenant_id, user_id, terms_version) ON terms_acceptances TO app_user;

    COMMENT ON TABLE terms_acceptances IS
      'KAN-27: append-only informed-consent evidence; one row per (tenant, user, terms version), server-timestamped.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS terms_acceptances;');
};
