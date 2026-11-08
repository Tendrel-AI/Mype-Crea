/**
 * D22 part 2: the prompt versions a conversation runs with.
 *
 * `conversations.prompt_versions` is a jsonb map of prompt key -> frozen version
 * (e.g. {"extractor": "extractor.v5", "logo-agent": "logo-agent.v1"}), NULL until the first turn
 * pins it. Add-only. No new grant or policy: app_user already has table-level UPDATE and the
 * existing `conversations_access` RLS policy applies to the new column.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE conversations ADD COLUMN prompt_versions jsonb
             CHECK (prompt_versions IS NULL OR jsonb_typeof(prompt_versions) = 'object');`);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS prompt_versions;`);
};
