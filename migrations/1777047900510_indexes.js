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
    pgm.sql(`CREATE INDEX ON messages      (tenant_id, conversation_id, created_at DESC);`);
    pgm.sql(`CREATE INDEX ON agent_tasks   (tenant_id, conversation_id, status);`);
    pgm.sql(`CREATE INDEX ON agent_tasks   (tenant_id, iteration_root_id);`);
    pgm.sql(`CREATE INDEX ON agent_tasks   (scheduled_for) WHERE status = 'pending';`);
    pgm.sql(`CREATE INDEX ON agent_tasks   (scheduled_for) WHERE status = 'in_progress';`);
    pgm.sql(`CREATE INDEX ON deliverables  (tenant_id, agent_task_id);`);
    pgm.sql(`CREATE INDEX ON llm_calls     (tenant_id, occurred_at);`);
    pgm.sql(`CREATE INDEX ON llm_calls     (tenant_id, user_id, occurred_at);`);
    pgm.sql(`CREATE INDEX ON llm_calls     (tenant_id, conversation_id);`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql(`
    DROP INDEX IF EXISTS messages_tenant_id_conversation_id_created_at_idx;
    DROP INDEX IF EXISTS agent_tasks_tenant_id_conversation_id_status_idx;
    DROP INDEX IF EXISTS agent_tasks_tenant_id_iteration_root_id_idx;
    DROP INDEX IF EXISTS agent_tasks_scheduled_for_idx;
    DROP INDEX IF EXISTS agent_tasks_scheduled_for_idx1;
    DROP INDEX IF EXISTS deliverables_tenant_id_agent_task_id_idx;
    DROP INDEX IF EXISTS llm_calls_tenant_id_occurred_at_idx;
    DROP INDEX IF EXISTS llm_calls_tenant_id_user_id_occurred_at_idx;
    DROP INDEX IF EXISTS llm_calls_tenant_id_conversation_id_idx;
  `);
};
