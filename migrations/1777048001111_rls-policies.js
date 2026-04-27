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
    pgm.sql(`
        ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
        ALTER TABLE users         FORCE  ROW LEVEL SECURITY;
        ALTER TABLE tenants       ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tenants       FORCE  ROW LEVEL SECURITY;
        ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
        ALTER TABLE conversations FORCE  ROW LEVEL SECURITY;
        ALTER TABLE messages      ENABLE ROW LEVEL SECURITY;
        ALTER TABLE messages      FORCE  ROW LEVEL SECURITY;
        ALTER TABLE agent_tasks   ENABLE ROW LEVEL SECURITY;
        ALTER TABLE agent_tasks   FORCE  ROW LEVEL SECURITY;
        ALTER TABLE deliverables  ENABLE ROW LEVEL SECURITY;
        ALTER TABLE deliverables  FORCE  ROW LEVEL SECURITY;
        ALTER TABLE llm_calls     ENABLE ROW LEVEL SECURITY;
        ALTER TABLE llm_calls     FORCE  ROW LEVEL SECURITY;
    `);

    // Tenants: visible only if it's your own tenant
    pgm.sql(`
        CREATE POLICY tenants_self ON tenants
        USING      (id = app.current_tenant_id())
        WITH CHECK (id = app.current_tenant_id());
    `);

    // Users: tenant-scoped
    pgm.sql(`
        CREATE POLICY users_tenant ON users
        USING      (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id());
    `);

    // Conversations, messages, deliverables: tenant + user (admin bypasses user check)
    pgm.sql(`
        CREATE POLICY conversations_access ON conversations
        USING (
            tenant_id = app.current_tenant_id()
            AND (app.is_tenant_admin() OR user_id = app.current_user_id())
        )
        WITH CHECK (
            tenant_id = app.current_tenant_id()
            AND (app.is_tenant_admin() OR user_id = app.current_user_id())
        );
    `);

    pgm.sql(`
        CREATE POLICY messages_access ON messages
        USING (
            tenant_id = app.current_tenant_id()
            AND (app.is_tenant_admin() OR user_id = app.current_user_id())
        )
        WITH CHECK (
            tenant_id = app.current_tenant_id()
            AND (app.is_tenant_admin() OR user_id = app.current_user_id())
        );
    `);

    pgm.sql(`
        CREATE POLICY deliverables_access ON deliverables
        USING (
            tenant_id = app.current_tenant_id()
            AND (app.is_tenant_admin() OR user_id = app.current_user_id())
        )
        WITH CHECK (
            tenant_id = app.current_tenant_id()
            AND (app.is_tenant_admin() OR user_id = app.current_user_id())
        );
    `);

    // Agent tasks and llm_calls: tenant-scoped. User-scoping on tasks is derived
    // through the conversation; we enforce via conversation ownership at app layer
    // because tasks don't currently carry user_id directly. If you want user-level
    // RLS on these too, add a denormalized user_id column.
    pgm.sql(`
        CREATE POLICY agent_tasks_tenant ON agent_tasks
        USING      (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id());
    `);

    pgm.sql(`
        CREATE POLICY llm_calls_tenant ON llm_calls
        USING      (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id());
    `);

};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql(`
        DROP POLICY IF EXISTS tenants_self          ON tenants;
        DROP POLICY IF EXISTS users_tenant          ON users;
        DROP POLICY IF EXISTS conversations_access  ON conversations;
        DROP POLICY IF EXISTS messages_access       ON messages;
        DROP POLICY IF EXISTS deliverables_access   ON deliverables;
        DROP POLICY IF EXISTS agent_tasks_tenant    ON agent_tasks;
        DROP POLICY IF EXISTS llm_calls_tenant      ON llm_calls;

        ALTER TABLE tenants       DISABLE ROW LEVEL SECURITY;
        ALTER TABLE users         DISABLE ROW LEVEL SECURITY;
        ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;
        ALTER TABLE messages      DISABLE ROW LEVEL SECURITY;
        ALTER TABLE agent_tasks   DISABLE ROW LEVEL SECURITY;
        ALTER TABLE deliverables  DISABLE ROW LEVEL SECURITY;
        ALTER TABLE llm_calls     DISABLE ROW LEVEL SECURITY;
    `);
};
