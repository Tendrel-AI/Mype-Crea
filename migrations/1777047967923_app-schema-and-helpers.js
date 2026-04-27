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
    pgm.sql(`CREATE SCHEMA app;`);

    pgm.sql(`
        CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
        LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
        $$;
    `);

    pgm.sql(`
        CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
        LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('app.user_id', true), '')::uuid
        $$;
    `);

    pgm.sql(`
        CREATE OR REPLACE FUNCTION app.is_tenant_admin() RETURNS boolean
        LANGUAGE sql STABLE AS $$
        SELECT coalesce(current_setting('app.is_tenant_admin', true) = 'true', false)
        $$;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql(`DROP SCHEMA IF EXISTS app CASCADE;`);
};
