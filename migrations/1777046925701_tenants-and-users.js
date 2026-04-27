/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
    // Tenants first, without the owner FK
    pgm.sql(`
        CREATE TABLE tenants (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        kind          tenant_kind NOT NULL,
        name          text        NOT NULL,
        plan          text        NOT NULL DEFAULT 'pilot',
        workos_org_id text        UNIQUE,
        owner_user_id uuid,
        created_at    timestamptz NOT NULL DEFAULT now()
        );
    `);

    // Users with composite uniqueness for FKs from child tables
    pgm.sql(`
        CREATE TABLE users (
        id             uuid        NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        workos_user_id text        NOT NULL,
        email          citext      NOT NULL,
        role           user_role   NOT NULL DEFAULT 'member',
        status         text        NOT NULL DEFAULT 'active',
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, email),
        UNIQUE (tenant_id, workos_user_id)
        );
    `);

    // Now the owner FK on tenants. Composite FK ensures owner belongs to this tenant.
    pgm.sql(`
        ALTER TABLE tenants
        ADD CONSTRAINT tenants_owner_fk
        FOREIGN KEY (id, owner_user_id)
        REFERENCES users(tenant_id, id)
    `);

    // Invariant: personal tenants must have an owner; institutional tenants may not.
    pgm.sql(`
        ALTER TABLE tenants
        ADD CONSTRAINT tenants_personal_requires_owner
        CHECK (kind = 'institutional' OR owner_user_id IS NOT NULL);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
    pgm.sql('DROP TABLE IF EXISTS users CASCADE;');
    pgm.sql('DROP TABLE IF EXISTS tenants CASCADE;');
};
