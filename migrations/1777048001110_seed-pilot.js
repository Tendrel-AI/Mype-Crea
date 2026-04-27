/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
    // Temporarily bypass RLS for seeding (we're running as the superuser, but FORCE
    // ROW LEVEL SECURITY means even the owner is subject to policies). Set the GUCs
    // to satisfy the policies.
    pgm.sql(`
        BEGIN;
        SET LOCAL row_security = off;

        WITH new_tenant AS (
        INSERT INTO tenants (kind, name, plan)
        VALUES ('institutional', 'Pilot Institution', 'pilot')
        RETURNING id
        )
        INSERT INTO users (tenant_id, workos_user_id, email, role)
        SELECT id, 'user_01KPSKNCADEVE80EDPAZXAD5RC', 'matias.lopez@tendrelai.com', 'admin'
        FROM new_tenant;

        COMMIT;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql(`
        DELETE FROM users   WHERE workos_user_id = 'user_01KPSKNCADEVE80EDPAZXAD5RC';
        DELETE FROM tenants WHERE name = 'Pilot Institution';
    `);
};
