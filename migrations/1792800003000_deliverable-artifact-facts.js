/**
 * KAN-81: persist the producing artifact's own `kind` and `metadata` on every deliverable.
 *
 * A URL deliverable used to store only `content_url`, so a `task_completed` notice rebuilt from
 * the database (`reconcileSettledTasks` / `enqueueSettledTaskEvents`) fell back to
 * `deliverables.kind` ('logo') and empty metadata, while the live notice carried the artifact's
 * `kind` ('image') and `metadata`. `settleTaskAndEnqueue` now writes both columns, and the
 * settled-task projection reads them first.
 *
 * Dedicated columns instead of reusing `content_inline`: `content_inline` is the inline content
 * and is returned to the client as `contentInline` (reload path, deliverable views); filling it
 * for URL deliverables would change those payloads.
 *
 * Both columns are nullable: rows written before this migration (and by the legacy worker
 * persistence path) keep NULL, and the projection falls back to `content_inline->>'kind'`, then
 * `deliverables.kind`. Add-only: existing rows are untouched.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE deliverables
      ADD COLUMN artifact_kind text,
      ADD COLUMN artifact_metadata jsonb;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE deliverables
      DROP COLUMN IF EXISTS artifact_metadata,
      DROP COLUMN IF EXISTS artifact_kind;
  `);
};
