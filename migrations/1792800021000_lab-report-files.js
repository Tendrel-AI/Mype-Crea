/**
 * D32 (nutrition label): lab-report PDFs are `brand_files` of kind `lab_report`. They belong to a
 * product (never to a brand alone), so the product-required rule lives in SQL next to the kind list.
 * The per-product limit (5) is enforced by the repo under the per-brand advisory lock.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE brand_files DROP CONSTRAINT IF EXISTS brand_files_kind_check;
    ALTER TABLE brand_files
      ADD CONSTRAINT brand_files_kind_check CHECK (kind IN ('logo', 'asset', 'lab_report'));
    ALTER TABLE brand_files
      ADD CONSTRAINT brand_files_lab_report_needs_product CHECK (kind <> 'lab_report' OR product_id IS NOT NULL);
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM brand_files WHERE kind = 'lab_report';
    ALTER TABLE brand_files DROP CONSTRAINT IF EXISTS brand_files_lab_report_needs_product;
    ALTER TABLE brand_files DROP CONSTRAINT IF EXISTS brand_files_kind_check;
    ALTER TABLE brand_files ADD CONSTRAINT brand_files_kind_check CHECK (kind IN ('logo', 'asset'));
  `);
};
