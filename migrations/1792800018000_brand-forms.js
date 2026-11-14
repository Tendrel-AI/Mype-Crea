/**
 * KAN-87: brand/product forms.
 *
 *  - `tenants.max_products_per_brand` (default 5) + `app.set_brand_product_limits(int, int)`: the
 *    admin-only helper that now sets «brands per user» and «products per brand». The old
 *    `max_conversations_per_brand` column and `app.set_brand_limits` stay in place but UNUSED
 *    (add-only rule): conversations per brand are no longer limited (cost is bounded by KAN-43).
 *  - `conversations.product_id`: a conversation may belong to a product. Brand/product consistency
 *    is enforced by the DATABASE: the FK (tenant, brand, product) -> products(tenant, brand, id)
 *    makes the product's brand equal to the conversation's brand, the FK (tenant, product, user)
 *    makes the owners match, and a CHECK forbids a product without a brand (a composite FK with a
 *    NULL column is not checked).
 *  - `brand_files`: logo / asset uploads of a brand (or one of its products); owner-only RLS, at most
 *    one logo per brand (partial unique index). Objects live in the private bucket under `storage_key`.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN max_products_per_brand int NOT NULL DEFAULT 5
      CONSTRAINT tenants_max_products_per_brand_check CHECK (max_products_per_brand >= 0);

    CREATE FUNCTION app.set_brand_product_limits(p_max_brands_per_user int, p_max_products_per_brand int)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      IF p_max_brands_per_user NOT BETWEEN 0 AND 1000
         OR p_max_products_per_brand NOT BETWEEN 0 AND 1000 THEN
        RAISE EXCEPTION 'brand limits must be between 0 and 1000';
      END IF;
      UPDATE public.tenants
         SET max_brands_per_user = p_max_brands_per_user,
             max_products_per_brand = p_max_products_per_brand,
             updated_at = now()
       WHERE id = app.current_tenant_id();
    END $$;
    REVOKE ALL ON FUNCTION app.set_brand_product_limits(int, int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.set_brand_product_limits(int, int) TO app_user;

    ALTER TABLE products ADD CONSTRAINT products_tenant_id_user_key UNIQUE (tenant_id, id, user_id);
    ALTER TABLE products ADD CONSTRAINT products_tenant_brand_id_key UNIQUE (tenant_id, brand_id, id);

    ALTER TABLE conversations ADD COLUMN product_id uuid;
    ALTER TABLE conversations ADD CONSTRAINT conversations_product_needs_brand
      CHECK (product_id IS NULL OR brand_id IS NOT NULL);
    ALTER TABLE conversations ADD CONSTRAINT conversations_product_brand_fk
      FOREIGN KEY (tenant_id, brand_id, product_id) REFERENCES products(tenant_id, brand_id, id) ON DELETE RESTRICT;
    ALTER TABLE conversations ADD CONSTRAINT conversations_product_owner_fk
      FOREIGN KEY (tenant_id, product_id, user_id) REFERENCES products(tenant_id, id, user_id) ON DELETE RESTRICT;
    CREATE INDEX conversations_tenant_product ON conversations (tenant_id, product_id);

    CREATE TABLE brand_files (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL,
      user_id       uuid        NOT NULL,
      brand_id      uuid        NOT NULL,
      product_id    uuid,
      kind          text        NOT NULL CHECK (kind IN ('logo', 'asset')),
      storage_key   text        NOT NULL,
      content_type  text        NOT NULL,
      byte_size     int         NOT NULL CHECK (byte_size > 0),
      sha256        text        NOT NULL,
      original_name text        NOT NULL CHECK (char_length(original_name) <= 200),
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, brand_id, user_id) REFERENCES brands(tenant_id, id, user_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, product_id, user_id) REFERENCES products(tenant_id, id, user_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, brand_id, product_id) REFERENCES products(tenant_id, brand_id, id) ON DELETE RESTRICT,
      CHECK (kind <> 'logo' OR product_id IS NULL)
    );
    CREATE INDEX brand_files_tenant_brand ON brand_files (tenant_id, brand_id);
    CREATE UNIQUE INDEX brand_files_one_logo ON brand_files (tenant_id, brand_id) WHERE kind = 'logo';

    ALTER TABLE brand_files ENABLE ROW LEVEL SECURITY;
    ALTER TABLE brand_files FORCE  ROW LEVEL SECURITY;
    CREATE POLICY brand_files_owner ON brand_files
      USING      (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id())
      WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());
    GRANT SELECT, INSERT, DELETE ON brand_files TO app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS brand_files;
    DROP INDEX IF EXISTS conversations_tenant_product;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_product_owner_fk;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_product_brand_fk;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_product_needs_brand;
    ALTER TABLE conversations DROP COLUMN IF EXISTS product_id;
    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tenant_brand_id_key;
    ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tenant_id_user_key;
    DROP FUNCTION IF EXISTS app.set_brand_product_limits(int, int);
    ALTER TABLE tenants DROP COLUMN IF EXISTS max_products_per_brand;
  `);
};
