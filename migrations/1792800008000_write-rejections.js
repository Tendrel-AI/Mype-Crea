/**
 * KAN-44 (SYS-11): append-only log of rejected writes (owner decision 2026-11-02).
 *
 * Design:
 *  - One row per refused write attempt: actor, tenant, channel, conversation (when known),
 *    field (agent + name, when relevant), reason code, and a SHA-256 hex of the offending
 *    payload or value. The raw value is never stored; the CHECK on `payload_hash` makes a raw
 *    value unstorable. `agent_id` / `field_name` hold only safe identifiers (CHECK), never free text.
 *  - `conversation_id` has no FK: a forged id from another user or tenant is exactly what this
 *    table records, and it must not be resolvable through a join.
 *  - Append-only: app_user gets SELECT and a column-level INSERT that excludes `id` and
 *    `created_at`, so the server clock sets the timestamp. No UPDATE/DELETE grant or policy.
 *  - RLS follows `ai_config_audit_events` (the closest audit precedent): a member reads only
 *    their own rows; an active tenant admin (persisted role, `app.has_tenant_admin()`) reads the
 *    tenant's rows. Inserts only as the current active member, for themselves.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE write_rejections (
      id              uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id       uuid        NOT NULL,
      user_id         uuid        NOT NULL,
      channel         text        NOT NULL CHECK (channel IN ('chat', 'panel', 'command', 'other')),
      conversation_id uuid,
      agent_id        text        CHECK (agent_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
      field_name      text        CHECK (field_name ~ '^[a-z][a-z0-9_-]{0,63}$'),
      reason          text        NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
      payload_hash    text        NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT
    );

    CREATE INDEX write_rejections_tenant_created ON write_rejections (tenant_id, created_at DESC);
    CREATE INDEX write_rejections_tenant_user_created ON write_rejections (tenant_id, user_id, created_at DESC);

    ALTER TABLE write_rejections ENABLE ROW LEVEL SECURITY;
    ALTER TABLE write_rejections FORCE  ROW LEVEL SECURITY;

    CREATE POLICY write_rejections_read ON write_rejections FOR SELECT
      USING (
        tenant_id = app.current_tenant_id()
        AND (user_id = app.current_user_id() OR app.has_tenant_admin())
      );
    CREATE POLICY write_rejections_insert ON write_rejections FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND app.has_active_member()
      );

    GRANT SELECT ON write_rejections TO app_user;
    GRANT INSERT (tenant_id, user_id, channel, conversation_id, agent_id, field_name, reason, payload_hash)
      ON write_rejections TO app_user;

    COMMENT ON TABLE write_rejections IS
      'KAN-44: append-only log of rejected write attempts; payload stored only as a SHA-256 hash, server-timestamped.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS write_rejections;');
};
