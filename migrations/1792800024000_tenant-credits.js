/**
 * D36 / F21 (component 29): prepaid credits per tenant.
 *
 *  - `tenant_credit_entries`: append-only USD ledger. `amount_usd` is signed by kind (recharge > 0,
 *    consumption < 0, adjustment <> 0); balance = SUM(amount_usd). Never updated or deleted.
 *  - Writers: `consumption` only by the settlement path (same transaction as the
 *    `usage_reservations` settle, bound by RLS to the caller's own settled reservation and its
 *    actual cost); `recharge`/`adjustment` only by an active platform actor (global transaction).
 *  - `tenant_provider_keys`: the OpenRouter sub-key the PLATFORM provisions per tenant. The key is
 *    ours: AES-GCM ciphertext under PROVIDER_KEY_KEK, readable only in a global (platform) context,
 *    never by tenant members.
 *  - `usage_reservations`: `cost_source` tells provider-reported costs from hand-typed estimates;
 *    `tenant_credits` joins the denial reasons (`tenant_budget` stays valid for old rows).
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE usage_reservations ADD COLUMN cost_source text
      CHECK (cost_source IN ('provider', 'estimate', 'flat'));
    ALTER TABLE usage_reservations DROP CONSTRAINT usage_reservations_denial_reason_check;
    ALTER TABLE usage_reservations ADD CONSTRAINT usage_reservations_denial_reason_check
      CHECK (denial_reason IN ('tenant_budget', 'tenant_credits', 'user_llm_hourly', 'user_image_daily', 'input_too_long'));
    GRANT UPDATE (cost_source) ON usage_reservations TO app_user;
    CREATE INDEX usage_reservations_tenant_reserved ON usage_reservations (tenant_id) WHERE status = 'reserved';

    CREATE TABLE tenant_credit_entries (
      id                     uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id              uuid          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      kind                   text          NOT NULL CHECK (kind IN ('recharge', 'consumption', 'adjustment')),
      amount_usd             numeric(14,6) NOT NULL,
      source                 text          NOT NULL CHECK (source IN ('manual', 'gateway', 'settlement')),
      idempotency_key        text          NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
      external_ref           text          CHECK (char_length(external_ref) <= 200),
      reason                 text          CHECK (char_length(reason) <= 500),
      actor_workos_user_id   text,
      usage_reservation_id   uuid,
      created_at             timestamptz   NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, idempotency_key),
      UNIQUE (tenant_id, usage_reservation_id),
      FOREIGN KEY (tenant_id, usage_reservation_id) REFERENCES usage_reservations(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT tenant_credit_entries_sign CHECK (
        (kind = 'recharge' AND amount_usd > 0)
        OR (kind = 'consumption' AND amount_usd < 0)
        OR (kind = 'adjustment' AND amount_usd <> 0)
      ),
      CONSTRAINT tenant_credit_entries_consumption_shape CHECK (
        (kind = 'consumption') = (source = 'settlement')
        AND (kind = 'consumption') = (usage_reservation_id IS NOT NULL)
      ),
      CONSTRAINT tenant_credit_entries_manual_actor CHECK (source <> 'manual' OR actor_workos_user_id IS NOT NULL)
    );
    CREATE INDEX tenant_credit_entries_tenant_created ON tenant_credit_entries (tenant_id, created_at DESC);

    ALTER TABLE tenant_credit_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_credit_entries FORCE  ROW LEVEL SECURITY;

    CREATE POLICY tenant_credit_entries_read ON tenant_credit_entries FOR SELECT
      USING (tenant_id = app.current_tenant_id() OR app.is_platform_admin());
    CREATE POLICY tenant_credit_entries_settle ON tenant_credit_entries FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND kind = 'consumption'
        AND source = 'settlement'
        AND app.has_active_member()
        AND EXISTS (
          SELECT 1 FROM usage_reservations r
           WHERE r.tenant_id = tenant_credit_entries.tenant_id
             AND r.id = tenant_credit_entries.usage_reservation_id
             AND r.user_id = app.current_user_id()
             AND r.status = 'settled'
             AND r.actual_cost_usd = -tenant_credit_entries.amount_usd
        )
      );
    CREATE POLICY tenant_credit_entries_platform_insert ON tenant_credit_entries FOR INSERT
      WITH CHECK (app.is_platform_actor() AND kind IN ('recharge', 'adjustment'));

    GRANT SELECT ON tenant_credit_entries TO app_user;
    GRANT INSERT (tenant_id, kind, amount_usd, source, idempotency_key, external_ref, reason,
                  actor_workos_user_id, usage_reservation_id)
      ON tenant_credit_entries TO app_user;

    COMMENT ON TABLE tenant_credit_entries IS
      'D36: append-only prepaid-credit ledger per tenant (balance = SUM(amount_usd)). No UPDATE/DELETE grant.';

    CREATE TABLE tenant_provider_keys (
      id               uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id        uuid          NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      provider         text          NOT NULL CHECK (provider IN ('openrouter')),
      key_ciphertext   text          NOT NULL,
      key_hash         text          NOT NULL,
      limit_usd        numeric(14,6) NOT NULL CHECK (limit_usd >= 0),
      status           text          NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      limit_synced_at  timestamptz,
      created_at       timestamptz   NOT NULL DEFAULT now(),
      updated_at       timestamptz   NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, provider)
    );

    ALTER TABLE tenant_provider_keys ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_provider_keys FORCE  ROW LEVEL SECURITY;

    -- Platform context only: tenant members have no policy, so they can never read the key.
    CREATE POLICY tenant_provider_keys_read ON tenant_provider_keys FOR SELECT
      USING (app.is_platform_admin());
    CREATE POLICY tenant_provider_keys_insert ON tenant_provider_keys FOR INSERT
      WITH CHECK (app.is_platform_actor());
    -- Limit sync after settlements runs without a human actor; the column grant bounds it.
    CREATE POLICY tenant_provider_keys_update ON tenant_provider_keys FOR UPDATE
      USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());

    GRANT SELECT ON tenant_provider_keys TO app_user;
    GRANT INSERT (tenant_id, provider, key_ciphertext, key_hash, limit_usd, status, limit_synced_at)
      ON tenant_provider_keys TO app_user;
    GRANT UPDATE (limit_usd, status, limit_synced_at, updated_at) ON tenant_provider_keys TO app_user;

    COMMENT ON TABLE tenant_provider_keys IS
      'D36: per-tenant OpenRouter sub-key owned by the platform; ciphertext is AES-GCM under PROVIDER_KEY_KEK.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tenant_provider_keys;
    DROP TABLE IF EXISTS tenant_credit_entries;
    DROP INDEX IF EXISTS usage_reservations_tenant_reserved;
    ALTER TABLE usage_reservations DROP COLUMN IF EXISTS cost_source;
  `);
};
