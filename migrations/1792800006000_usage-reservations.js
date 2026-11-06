/**
 * KAN-43 (SYS-08): usage limits before any model/image provider call.
 *
 * Design (policy: pipeline/decisions/KAN-43-usage-limits-policy.md):
 *  - One row per provider call the gateway was asked to make: `reserved` (estimated cost held
 *    before the call), `settled` (reconciled with the real cost after it, success or failure)
 *    or `denied` (over a limit; the provider was never called).
 *  - Reservations serialize per tenant on a transaction-scoped advisory lock taken by the
 *    repository (`usage_reservations:<tenant>`), so concurrent calls cannot overspend.
 *  - Correlation columns (conversation, turn, attempt, agent task) are plain ids with no FK:
 *    the ledger outlives the rows it describes and links them to ai_turn_attempts / agent_tasks
 *    for KAN-42.
 *  - RLS: tenant-wide SELECT (the budget is a tenant sum, like llm_calls); INSERT/UPDATE only for
 *    the caller's own rows as an active member; only a `reserved` row can be settled. No DELETE.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE usage_reservations (
      id                 uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id          uuid          NOT NULL,
      user_id            uuid          NOT NULL,
      kind               text          NOT NULL CHECK (kind IN ('llm', 'image')),
      status             text          NOT NULL CHECK (status IN ('reserved', 'settled', 'denied')),
      denial_reason      text          CHECK (denial_reason IN ('tenant_budget', 'user_llm_hourly', 'user_image_daily', 'input_too_long')),
      estimated_cost_usd numeric(12,6) NOT NULL CHECK (estimated_cost_usd >= 0),
      actual_cost_usd    numeric(12,6) CHECK (actual_cost_usd >= 0),
      outcome            text          CHECK (outcome IN ('succeeded', 'failed')),
      pricing_version    text          NOT NULL,
      provider           text,
      model              text,
      conversation_id    uuid,
      turn_id            uuid,
      attempt_id         uuid,
      agent_task_id      uuid,
      created_at         timestamptz   NOT NULL DEFAULT now(),
      settled_at         timestamptz,
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT usage_reservations_denial_reason CHECK ((status = 'denied') = (denial_reason IS NOT NULL)),
      CONSTRAINT usage_reservations_settlement CHECK (
        (status = 'settled') = (actual_cost_usd IS NOT NULL AND outcome IS NOT NULL AND settled_at IS NOT NULL)
      )
    );

    CREATE INDEX usage_reservations_tenant_created ON usage_reservations (tenant_id, created_at);
    CREATE INDEX usage_reservations_tenant_user_kind_created ON usage_reservations (tenant_id, user_id, kind, created_at);

    ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE usage_reservations FORCE  ROW LEVEL SECURITY;

    CREATE POLICY usage_reservations_read ON usage_reservations FOR SELECT
      USING (tenant_id = app.current_tenant_id());
    CREATE POLICY usage_reservations_insert ON usage_reservations FOR INSERT
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND app.has_active_member()
      );
    CREATE POLICY usage_reservations_settle ON usage_reservations FOR UPDATE
      USING (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND status = 'reserved'
      )
      WITH CHECK (
        tenant_id = app.current_tenant_id()
        AND user_id = app.current_user_id()
        AND status = 'settled'
      );

    GRANT SELECT ON usage_reservations TO app_user;
    GRANT INSERT (tenant_id, user_id, kind, status, denial_reason, estimated_cost_usd, pricing_version,
                  provider, model, conversation_id, turn_id, attempt_id, agent_task_id)
      ON usage_reservations TO app_user;
    GRANT UPDATE (status, actual_cost_usd, outcome, settled_at) ON usage_reservations TO app_user;

    COMMENT ON TABLE usage_reservations IS
      'KAN-43: usage ledger; one row per gated provider call (reserved -> settled, or denied). Server-timestamped.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS usage_reservations;');
};
