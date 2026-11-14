/**
 * KAN-89 (D25): brand-level identity. The name, logo and tagline are approved once per brand; every
 * conversation of the brand reads the same approved result.
 *
 *  - `brand_approvals` holds ONE current pointer per (brand, kind): the deliverable approved as the
 *    brand's result and the conversation it lives in. The per-conversation history
 *    (`deliverable_approvals`, `deliverables.selected_at`) is untouched; the repo writes the pointer in
 *    the same transaction as the approval, under a `FOR UPDATE` lock on the brand row.
 *  - Composite FKs carry the owner (`user_id`): FK checks bypass RLS, so the owner match is what stops
 *    a pointer from reaching another user's brand, conversation or deliverable.
 *  - The deliverable must be of the pointed kind and live in the pointed conversation, and that
 *    conversation must belong to the pointed brand (new UNIQUE on conversations).
 *  - Owner-only RLS (FORCE). app_user can read, insert and move the pointer, never delete it.
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_tenant_id_brand_key UNIQUE (tenant_id, id, brand_id);

    CREATE TABLE brand_approvals (
      id              uuid             NOT NULL DEFAULT gen_random_uuid(),
      tenant_id       uuid             NOT NULL,
      user_id         uuid             NOT NULL,
      brand_id        uuid             NOT NULL,
      kind            deliverable_kind NOT NULL,
      deliverable_id  uuid             NOT NULL,
      conversation_id uuid             NOT NULL,
      approved_at     timestamptz      NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, brand_id, kind),
      FOREIGN KEY (tenant_id, brand_id, user_id) REFERENCES brands(tenant_id, id, user_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, conversation_id, user_id) REFERENCES conversations(tenant_id, id, user_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, conversation_id, brand_id) REFERENCES conversations(tenant_id, id, brand_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, deliverable_id, conversation_id, kind)
        REFERENCES deliverables(tenant_id, id, conversation_id, kind) ON DELETE CASCADE
    );
    CREATE INDEX brand_approvals_tenant_brand ON brand_approvals (tenant_id, brand_id);

    ALTER TABLE brand_approvals ENABLE ROW LEVEL SECURITY;
    ALTER TABLE brand_approvals FORCE  ROW LEVEL SECURITY;
    CREATE POLICY brand_approvals_owner ON brand_approvals
      USING      (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id())
      WITH CHECK (tenant_id = app.current_tenant_id() AND user_id = app.current_user_id());

    GRANT SELECT, INSERT ON brand_approvals TO app_user;
    GRANT UPDATE (deliverable_id, conversation_id, approved_at) ON brand_approvals TO app_user;

    COMMENT ON TABLE brand_approvals IS
      'KAN-89: current approved deliverable per (brand, kind) for brand-level kinds; history stays in deliverable_approvals.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS brand_approvals;
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_id_brand_key;
  `);
};
