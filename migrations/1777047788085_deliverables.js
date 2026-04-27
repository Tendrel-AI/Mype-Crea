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
        CREATE TABLE deliverables (
        id              uuid              NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid              NOT NULL,
        conversation_id uuid              NOT NULL,
        agent_task_id   uuid              NOT NULL,
        user_id         uuid              NOT NULL,
        kind            deliverable_kind  NOT NULL,
        content_url     text,
        content_inline  jsonb,
        selected_at     timestamptz,
        superseded_by   uuid,
        created_at      timestamptz       NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, agent_task_id)   REFERENCES agent_tasks(tenant_id, id)   ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, user_id)         REFERENCES users(tenant_id, id)         ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, superseded_by)   REFERENCES deliverables(tenant_id, id)  ON DELETE SET NULL,
        CHECK (content_url IS NOT NULL OR content_inline IS NOT NULL)
        );
    `);

    // Exactly one selected deliverable per (conversation, kind)
    pgm.sql(`
        CREATE UNIQUE INDEX deliverables_selected_per_kind
        ON deliverables (conversation_id, kind)
        WHERE selected_at IS NOT NULL;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql('DROP TABLE IF EXISTS deliverables CASCADE;');
};
