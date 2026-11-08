/**
 * KAN-85: brands (a user's business identity) and products (owned by a brand).
 *
 *  - `brands`: owner-only rows (tenant + user). `attributes` is a blank JSONB canvas for future
 *    fields. `status` is `active` / `archived` (no unarchive); an archived brand frees its slot.
 *  - `products`: owner-only rows that belong to a brand (composite FK on the tenant).
 *  - `conversations.brand_id` is NULL for legacy rows and set for every conversation created
 *    from a brand.
 *  - Products and conversations reference brands by (tenant_id, brand_id, user_id): FK checks
 *    bypass RLS, so the owner match is what stops a link to another user's brand in the tenant.
 *  - Two tenant-admin limits live on `tenants`: `max_brands_per_user` (default 3) and
 *    `max_conversations_per_brand` (default 5). app_user has NO column grant on them, and the
 *    broad `tenants_self` policy would otherwise let any member write them, so the only way to
 *    change them is `app.set_brand_limits`, a SECURITY DEFINER helper that re-checks
 *    `app.has_tenant_admin()` (persisted active admin) and validates the range.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants ADD COLUMN max_brands_per_user int NOT NULL DEFAULT 3
      CONSTRAINT tenants_max_brands_per_user_check CHECK (max_brands_per_user >= 0);
    ALTER TABLE tenants ADD COLUMN max_conversations_per_brand int NOT NULL DEFAULT 5
      CONSTRAINT tenants_max_conversations_per_brand_check CHECK (max_conversations_per_brand >= 0);

    CREATE FUNCTION app.set_brand_limits(p_max_brands_per_user int, p_max_conversations_per_brand int)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $$
    BEGIN
      IF NOT app.has_tenant_admin() THEN RAISE EXCEPTION 'tenant admin required'; END IF;
      IF p_max_brands_per_user NOT BETWEEN 0 AND 1000
         OR p_max_conversations_per_brand NOT BETWEEN 0 AND 1000 THEN
        RAISE EXCEPTION 'brand limits must be between 0 and 1000';
      END IF;
      UPDATE public.tenants
         SET max_brands_per_user = p_max_brands_per_user,
             max_conversations_per_brand = p_max_conversations_per_brand,
             updated_at = now()
       WHERE id = app.current_tenant_id();
    END $$;
    REVOKE ALL ON FUNCTION app.set_brand_limits(int, int) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.set_brand_limits(int, int) TO app_user;

    CREATE TABLE brands (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL,
      user_id     uuid        NOT NULL,
      name        text        CHECK (char_length(name) <= 120),
      attributes  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
      status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      archived_at timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, id, user_id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      CHECK ((status = 'archived') = (archived_at IS NOT NULL))
    );
    CREATE INDEX brands_tenant_user_status ON brands (tenant_id, user_id, status);

    CREATE TABLE products (
      id         uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id  uuid        NOT NULL,
      brand_id   uuid        NOT NULL,
      user_id    uuid        NOT NULL,
      name       text        CHECK (char_length(name) <= 120),
      attributes jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, brand_id, user_id) REFERENCES brands(tenant_id, id, user_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
    );
    CREATE INDEX products_tenant_brand ON products (tenant_id, brand_id, created_at);

    ALTER TABLE brands   ENABLE ROW LEVEL SECURITY;
    ALTER TABLE brands   FORCE  ROW LEVEL SECURITY;
    ALTER TABLE products ENABLE ROW LEVEL SECURITY;
    ALTER TABLE products FORCE  ROW LEVEL SECURITY;

    CREATE POLICY brands_owner ON brands
      USING      (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id())
      WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());
    CREATE POLICY products_owner ON products
      USING      (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id())
      WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());

    GRANT SELECT, INSERT ON brands, products TO app_user;
    GRANT UPDATE (name, attributes, status, archived_at, updated_at) ON brands TO app_user;
    GRANT UPDATE (name, attributes, updated_at) ON products TO app_user;

    ALTER TABLE conversations ADD COLUMN brand_id uuid;
    ALTER TABLE conversations ADD CONSTRAINT conversations_brand_fk
      FOREIGN KEY (tenant_id, brand_id, user_id) REFERENCES brands(tenant_id, id, user_id) ON DELETE RESTRICT;
    CREATE INDEX conversations_tenant_brand ON conversations (tenant_id, brand_id);
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_brand_fk;
    DROP INDEX IF EXISTS conversations_tenant_brand;
    ALTER TABLE conversations DROP COLUMN IF EXISTS brand_id;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS brands;
    DROP FUNCTION IF EXISTS app.set_brand_limits(int, int);
    ALTER TABLE tenants DROP COLUMN IF EXISTS max_conversations_per_brand;
    ALTER TABLE tenants DROP COLUMN IF EXISTS max_brands_per_user;
  `);
};
