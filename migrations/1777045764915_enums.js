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
    pgm.createType('tenant_kind',               ['institutional', 'personal']);
    pgm.createType('user_role',                 ['admin', 'member']);
    pgm.createType('conversation_status',       ['active', 'completed', 'abandoned']);
    pgm.createType('message_role',              ['user', 'assistant', 'system']);
    pgm.createType('message_generation_status', ['pending', 'complete', 'failed']);
    pgm.createType('task_status',               ['pending', 'in_progress', 'completed', 'failed', 'canceled']);
    pgm.createType('iteration_trigger',         ['user_reject', 'user_regenerate', 'failure']);
    pgm.createType('deliverable_kind',          ['logo', 'business_name', 'tagline', 'label', 'social_pack']);
    pgm.createType('error_category',            ['transient', 'content_policy', 'permanent_bug']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.dropType('error_category');
    pgm.dropType('deliverable_kind');
    pgm.dropType('iteration_trigger');
    pgm.dropType('task_status');
    pgm.dropType('message_generation_status');
    pgm.dropType('message_role');
    pgm.dropType('conversation_status');
    pgm.dropType('user_role');
    pgm.dropType('tenant_kind');
};
