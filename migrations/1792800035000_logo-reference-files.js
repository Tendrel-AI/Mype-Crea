/**
 * D62: reference images the owner uploads in the logo box are `brand_files` of kind `logo_reference`.
 * They belong to the brand (never to a product), so the brand-level rule lives in SQL next to the kind list.
 * The per-brand limit (3) is enforced by the repo under the per-brand advisory lock.
 * Add-only: the kind CHECK is replaced by a wider one (a loosening); no data is touched.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE brand_files DROP CONSTRAINT IF EXISTS brand_files_kind_check;
    ALTER TABLE brand_files
      ADD CONSTRAINT brand_files_kind_check CHECK (kind IN ('logo', 'asset', 'lab_report', 'logo_reference'));
    ALTER TABLE brand_files
      ADD CONSTRAINT brand_files_logo_reference_brand_level CHECK (kind <> 'logo_reference' OR product_id IS NULL);
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM brand_files WHERE kind = 'logo_reference';
    ALTER TABLE brand_files DROP CONSTRAINT IF EXISTS brand_files_logo_reference_brand_level;
    ALTER TABLE brand_files DROP CONSTRAINT IF EXISTS brand_files_kind_check;
    ALTER TABLE brand_files ADD CONSTRAINT brand_files_kind_check CHECK (kind IN ('logo', 'asset', 'lab_report'));
  `);
};
