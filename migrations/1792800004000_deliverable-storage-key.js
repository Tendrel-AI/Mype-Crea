/**
 * KAN-52: generated images live in a private bucket; the deliverable records the object key.
 *
 * `storage_key` is the bucket object key (`tenants/<tenant_id>/conversations/<c>/tasks/<t>/<i>.<ext>`),
 * written by `settleTaskAndEnqueue` in the same transaction that marks the task completed, and only
 * after the worker uploaded the object. When it is set, every client-facing URL of the row is
 * `/api/assets/<id>` (an authorized redirect to a 15-minute presigned URL), never `content_url`.
 *
 * Provenance: `content_url` keeps the provider (fal.ai) URL the image was copied from. Reusing it
 * means stored rows still satisfy `CHECK (content_url IS NOT NULL OR content_inline IS NOT NULL)`
 * with no CHECK change, and rows without a key (written before KAN-52, or locally without a bucket)
 * keep today's meaning and URL.
 *
 * The CHECK pins every key under its own tenant's prefix, a database backstop against a row that
 * points at another tenant's objects. Add-only: a new nullable column (all existing rows NULL, so
 * the constraint validates instantly).
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE deliverables
      ADD COLUMN storage_key text,
      ADD CONSTRAINT deliverables_storage_key_tenant_prefix
        CHECK (storage_key IS NULL OR starts_with(storage_key, 'tenants/' || tenant_id::text || '/'));
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE deliverables
      DROP CONSTRAINT IF EXISTS deliverables_storage_key_tenant_prefix,
      DROP COLUMN IF EXISTS storage_key;
  `);
};
