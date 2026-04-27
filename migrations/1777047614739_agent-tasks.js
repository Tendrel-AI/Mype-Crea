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
        CREATE TABLE agent_tasks (
        id                     uuid               NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid               NOT NULL,
        conversation_id        uuid               NOT NULL,
        agent_id               text               NOT NULL,
        agent_card_version     text               NOT NULL,
        status                 task_status        NOT NULL DEFAULT 'pending',
        scheduled_for          timestamptz        NOT NULL DEFAULT now(),
        attempts               integer            NOT NULL DEFAULT 0,
        last_attempt_at        timestamptz,
        idempotency_key        uuid               NOT NULL,
        iteration_trigger      iteration_trigger,
        parent_task_id         uuid,
        iteration_root_id      uuid               NOT NULL,
        iteration_number       integer            NOT NULL DEFAULT 1,
        requirements_snapshot  jsonb              NOT NULL,
        error                  jsonb,
        error_category         error_category,
        dispatched_at          timestamptz,
        completed_at           timestamptz,
        created_at             timestamptz        NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, idempotency_key),
        FOREIGN KEY (tenant_id, conversation_id)   REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, parent_task_id)    REFERENCES agent_tasks(tenant_id, id)   ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, iteration_root_id) REFERENCES agent_tasks(tenant_id, id)   ON DELETE CASCADE,
        CHECK ((error IS NULL) = (error_category IS NULL)),
        CHECK ((parent_task_id IS NULL) = (iteration_number = 1))
        );
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql('DROP TABLE IF EXISTS agent_tasks CASCADE;');
};
