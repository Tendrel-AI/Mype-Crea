/**
 * Audit fix: `tenants_self` (FOR ALL) let any query inside a tenant context run
 * `UPDATE tenants SET status = 'active'` (app_user holds UPDATE on status), undoing a platform
 * admin's disable, because permissive policies are OR'd. Platform writes already go through
 * `tenants_platform_metadata`, so `tenants_self` becomes SELECT-only. SECURITY DEFINER helpers
 * (`app.set_brand_limits`) run as owner with row_security off and are unaffected.
 */
// destructive-ok: policy is replaced by a stricter one in the same migration; no data is lost
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    DROP POLICY tenants_self ON tenants;
    CREATE POLICY tenants_self ON tenants FOR SELECT
      USING (id = app.current_tenant_id());
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP POLICY tenants_self ON tenants;
    CREATE POLICY tenants_self ON tenants
      USING      (id = app.current_tenant_id())
      WITH CHECK (id = app.current_tenant_id());
  `);
};
