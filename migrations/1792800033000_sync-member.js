/**
 * D52: WorkOS membership is the source of truth for access and role; `users` is a just-in-time
 * mirror. Identity resolution may therefore create / relink / role-sync ONE row of the tenant
 * bound in the transaction, and nothing else. `app_user` has no INSERT/UPDATE on `users` outside
 * tenant-admin policies, so the only writer for a signing-in person is this narrow function:
 *  - scoped to `app.current_tenant_id()`; a tenant that is not bound raises;
 *  - found by workos_user_id: sync the role (active rows only);
 *  - else, same-tenant row with that email: relinked only when WorkOS verified the email, and
 *    only when the row is active; never across tenants;
 *  - else insert an active mirror row (the email is lowercased);
 *  - it NEVER changes `status`: an inactive row stays inactive and is returned so the caller denies.
 * Returns zero rows when the email belongs to another account that could not be relinked.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION app.sync_member(
      p_workos_user_id text, p_email text, p_email_verified boolean, p_role text)
    RETURNS TABLE (o_user_id uuid, o_role text, o_status text, o_outcome text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public, app, pg_temp
    SET row_security = off
    AS $fn$
    DECLARE
      t uuid := app.current_tenant_id();
      v_email text := lower(btrim(coalesce(p_email, '')));
      r public.users%ROWTYPE;
    BEGIN
      IF t IS NULL THEN RAISE EXCEPTION 'tenant context is required'; END IF;
      IF p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'invalid role'; END IF;
      IF v_email = '' OR coalesce(p_workos_user_id, '') = '' THEN RAISE EXCEPTION 'email and workos user id are required'; END IF;

      SELECT * INTO r FROM public.users u WHERE u.tenant_id = t AND u.workos_user_id = p_workos_user_id FOR UPDATE;
      IF FOUND THEN
        IF r.status = 'active' AND r.role::text <> p_role THEN
          UPDATE public.users u SET role = p_role::public.user_role WHERE u.id = r.id;
          r.role := p_role::public.user_role;
        END IF;
        RETURN QUERY SELECT r.id, r.role::text, r.status, 'existing'::text;
        RETURN;
      END IF;

      SELECT * INTO r FROM public.users u WHERE u.tenant_id = t AND u.email = v_email::public.citext FOR UPDATE;
      IF FOUND THEN
        IF NOT coalesce(p_email_verified, false) THEN RETURN; END IF;
        IF r.status <> 'active' THEN
          RETURN QUERY SELECT r.id, r.role::text, r.status, 'denied_inactive'::text;
          RETURN;
        END IF;
        UPDATE public.users u SET workos_user_id = p_workos_user_id, role = p_role::public.user_role WHERE u.id = r.id;
        RETURN QUERY SELECT r.id, p_role, r.status, 'relinked'::text;
        RETURN;
      END IF;

      INSERT INTO public.users (tenant_id, workos_user_id, email, role, status)
        VALUES (t, p_workos_user_id, v_email, p_role::public.user_role, 'active')
        ON CONFLICT DO NOTHING
        RETURNING * INTO r;
      IF FOUND THEN
        RETURN QUERY SELECT r.id, r.role::text, r.status, 'created'::text;
        RETURN;
      END IF;
      -- A concurrent first sign-in inserted the same person.
      SELECT * INTO r FROM public.users u WHERE u.tenant_id = t AND u.workos_user_id = p_workos_user_id;
      IF FOUND THEN
        RETURN QUERY SELECT r.id, r.role::text, r.status, 'existing'::text;
      END IF;
    END $fn$;
    REVOKE ALL ON FUNCTION app.sync_member(text, text, boolean, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app.sync_member(text, text, boolean, text) TO app_user;
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS app.sync_member(text, text, boolean, text);`);
};
