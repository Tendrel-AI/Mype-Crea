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
        CREATE TABLE messages (
        id                 uuid                      NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid                      NOT NULL,
        conversation_id    uuid                      NOT NULL,
        user_id            uuid                      NOT NULL,
        role               message_role              NOT NULL,
        content            text                      NOT NULL,
        generation_status  message_generation_status NOT NULL DEFAULT 'complete',
        completed_at       timestamptz,
        created_at         timestamptz               NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, user_id)         REFERENCES users(tenant_id, id)         ON DELETE RESTRICT
        );
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql('DROP TABLE IF EXISTS messages CASCADE;');
};
