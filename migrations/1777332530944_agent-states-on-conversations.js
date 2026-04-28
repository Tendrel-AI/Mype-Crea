/**
 * Adds agent_states jsonb to conversations to persist the orchestrator's
 * ConversationSnapshot.agentStates. Whole-row update on every mutation;
 * normalize later if iteration history demands it.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE conversations
          ADD COLUMN agent_states jsonb NOT NULL DEFAULT '{}'::jsonb;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE conversations DROP COLUMN agent_states;`);
};
