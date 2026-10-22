/**
 * Allow an active tenant member to read the shared base of the tenant's
 * currently activated local release. The local tables remain tenant-scoped
 * by their existing RLS policies.
 */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`
    CREATE POLICY ai_shared_releases_active_activation_member_read
      ON ai_shared_releases FOR SELECT TO app_user
      USING (
        app.has_active_member()
        AND EXISTS (
          SELECT 1
            FROM public.ai_release_activations activation
            JOIN public.ai_releases release
              ON release.tenant_id = activation.tenant_id
             AND release.id = activation.release_id
           WHERE activation.tenant_id = app.current_tenant_id()
             AND release.base_shared_release_id = ai_shared_releases.id
        )
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS ai_shared_releases_active_activation_member_read
      ON ai_shared_releases;
  `);
};
