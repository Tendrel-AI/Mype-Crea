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
        CREATE TABLE llm_calls (
        id              uuid        NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid        NOT NULL,
        conversation_id uuid,
        user_id         uuid,
        agent_task_id   uuid,
        model           text        NOT NULL,
        model_revision  text        NOT NULL,
        prompt_version  text        NOT NULL,
        input_tokens    integer     NOT NULL,
        output_tokens   integer     NOT NULL,
        latency_ms      integer     NOT NULL,
        occurred_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, user_id)         REFERENCES users(tenant_id, id)         ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, agent_task_id)   REFERENCES agent_tasks(tenant_id, id)   ON DELETE SET NULL
        );
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql('DROP TABLE IF EXISTS llm_calls CASCADE;');
};
