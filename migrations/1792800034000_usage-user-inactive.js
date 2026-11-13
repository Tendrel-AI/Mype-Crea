/**
 * D52: the usage gateway refuses a reservation for an inactive user (backstop of `assertOwnerActive`).
 * `user_inactive` joins the allowed denial reasons. Add-only: no data change, old rows stay valid.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE usage_reservations DROP CONSTRAINT usage_reservations_denial_reason_check;
    ALTER TABLE usage_reservations ADD CONSTRAINT usage_reservations_denial_reason_check
      CHECK (denial_reason IN ('tenant_budget', 'tenant_credits', 'user_llm_hourly', 'user_image_daily', 'input_too_long', 'user_inactive'));
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM usage_reservations WHERE denial_reason = 'user_inactive';
    ALTER TABLE usage_reservations DROP CONSTRAINT usage_reservations_denial_reason_check;
    ALTER TABLE usage_reservations ADD CONSTRAINT usage_reservations_denial_reason_check
      CHECK (denial_reason IN ('tenant_budget', 'tenant_credits', 'user_llm_hourly', 'user_image_daily', 'input_too_long'));
  `);
};
