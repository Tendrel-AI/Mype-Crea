/**
 * KAN-34 (RF-06) / KAN-65 R2: database backstop for the iteration refinement shape.
 *
 * Refinement is stored only in the iteration's `agent_tasks.requirements_snapshot` under the
 * reserved key `refinement`; it never touches the brief (`conversations.agent_states`). The
 * repository (`src/repos/refinement-rules.ts`) validates and normalizes the payload first. This
 * CHECK applies the same rule so no other write path can store an oversized or malformed
 * refinement. Both definitions are covered by one parity test with the same cases.
 *
 * Rule (Phase 1 caps; per-type iteration caps are deferred to KAN-43):
 *  - `refinement` is an object with only `parameterChanges`, `observations`,
 *    `anchorDeliverableId`.
 *  - `parameterChanges`: object, at most 20 keys; each key matches ^[A-Za-z][A-Za-z0-9_]{0,63}$;
 *    each value is a string (at most 200 characters), a number, or a boolean.
 *  - `observations`: array of at most 5 strings; each 1..500 characters (code points) and
 *    containing at least one character other than ASCII whitespace.
 *  - `anchorDeliverableId`: null or a lowercase UUID string.
 *  - A refinement is only allowed on an iteration row (`parent_task_id IS NOT NULL`).
 * Existing rows carry no `refinement` key, so the constraint validates immediately.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(String.raw`
    CREATE OR REPLACE FUNCTION app.is_valid_refinement(refinement jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(
        jsonb_typeof(refinement) = 'object'
        AND (refinement - ARRAY['parameterChanges', 'observations', 'anchorDeliverableId']) = '{}'::jsonb
        AND jsonb_typeof(refinement -> 'parameterChanges') = 'object'
        AND (SELECT count(*) FROM jsonb_object_keys(refinement -> 'parameterChanges')) <= 20
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(refinement -> 'parameterChanges') AS p(key, value)
           WHERE p.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
              OR jsonb_typeof(p.value) NOT IN ('string', 'number', 'boolean')
              OR (jsonb_typeof(p.value) = 'string' AND char_length(p.value #>> '{}') > 200)
        )
        AND jsonb_typeof(refinement -> 'observations') = 'array'
        AND jsonb_array_length(refinement -> 'observations') <= 5
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(refinement -> 'observations') AS o(value)
           WHERE jsonb_typeof(o.value) <> 'string'
              OR char_length(o.value #>> '{}') NOT BETWEEN 1 AND 500
              OR (o.value #>> '{}') !~ '[^ \t\n\r\f\v]'
        )
        AND (
          NOT (refinement ? 'anchorDeliverableId')
          OR jsonb_typeof(refinement -> 'anchorDeliverableId') = 'null'
          OR (
            jsonb_typeof(refinement -> 'anchorDeliverableId') = 'string'
            AND (refinement ->> 'anchorDeliverableId')
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
        ),
        false
      )
    $$;
    GRANT EXECUTE ON FUNCTION app.is_valid_refinement(jsonb) TO app_user;

    ALTER TABLE agent_tasks
      ADD CONSTRAINT agent_tasks_refinement_valid CHECK (
        NOT (requirements_snapshot ? 'refinement')
        OR (parent_task_id IS NOT NULL AND app.is_valid_refinement(requirements_snapshot -> 'refinement'))
      );
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_refinement_valid;
    DROP FUNCTION IF EXISTS app.is_valid_refinement(jsonb);
  `);
};
