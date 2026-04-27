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
        CREATE TABLE conversations (
        id           uuid                NOT NULL DEFAULT gen_random_uuid(),
        tenant_id    uuid                NOT NULL,
        user_id      uuid                NOT NULL,
        status       conversation_status NOT NULL DEFAULT 'active',
        started_at   timestamptz         NOT NULL DEFAULT now(),
        completed_at timestamptz,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
        );
    `);

};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql('DROP TABLE IF EXISTS conversations CASCADE;');
};
