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
    // Create a dedicated app role. Use a strong password — rotate from Railway's
    // dashboard after running this.
    pgm.sql(`
        DO $$
        BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
            CREATE ROLE app_user WITH LOGIN PASSWORD 'change_me_immediately';
        END IF;
        END $$;
    `);

    pgm.sql(`GRANT USAGE ON SCHEMA public TO app_user;`);
    pgm.sql(`GRANT USAGE ON SCHEMA app    TO app_user;`);

    pgm.sql(`
        GRANT SELECT, INSERT, UPDATE, DELETE ON
        tenants, users, conversations, messages,
        agent_tasks, deliverables, llm_calls
        TO app_user;
    `);

    pgm.sql(`
        GRANT EXECUTE ON FUNCTION
        app.current_tenant_id(),
        app.current_user_id(),
        app.is_tenant_admin()
        TO app_user;
    `);

    // No BYPASSRLS — this is deliberate.
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql(`
        REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM app_user;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app    FROM app_user;
        REVOKE USAGE ON SCHEMA public FROM app_user;
        REVOKE USAGE ON SCHEMA app    FROM app_user;
        DROP ROLE IF EXISTS app_user;
    `);
};
