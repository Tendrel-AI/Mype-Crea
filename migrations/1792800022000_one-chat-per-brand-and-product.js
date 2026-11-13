/**
 * D40 / D44: one active conversation per brand and one per product.
 *
 *  - Brand-level chat: at most one active conversation per (tenant, brand) with `product_id IS NULL`.
 *  - Product chat: at most one active conversation per (tenant, product).
 *  - Add-only: nothing is dropped. Before the indexes can exist, older duplicates (the former
 *    "several chats per brand" model) are marked `abandoned`, keeping the newest chat active. Abandoned
 *    chats keep their rows and still open by direct URL; they just leave the lists.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    UPDATE conversations c SET status = 'abandoned'
     WHERE c.status = 'active' AND c.brand_id IS NOT NULL AND c.product_id IS NULL
       AND EXISTS (SELECT 1 FROM conversations n
                    WHERE n.tenant_id = c.tenant_id AND n.brand_id = c.brand_id AND n.product_id IS NULL
                      AND n.status = 'active' AND (n.started_at, n.id) > (c.started_at, c.id));
    UPDATE conversations c SET status = 'abandoned'
     WHERE c.status = 'active' AND c.product_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM conversations n
                    WHERE n.tenant_id = c.tenant_id AND n.product_id = c.product_id
                      AND n.status = 'active' AND (n.started_at, n.id) > (c.started_at, c.id));

    CREATE UNIQUE INDEX conversations_one_active_per_brand
      ON conversations (tenant_id, brand_id)
      WHERE status = 'active' AND brand_id IS NOT NULL AND product_id IS NULL;
    CREATE UNIQUE INDEX conversations_one_active_per_product
      ON conversations (tenant_id, product_id)
      WHERE status = 'active' AND product_id IS NOT NULL;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS conversations_one_active_per_product;
    DROP INDEX IF EXISTS conversations_one_active_per_brand;
  `);
};
