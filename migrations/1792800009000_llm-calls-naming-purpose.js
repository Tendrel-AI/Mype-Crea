/**
 * KAN-31: allow `naming` (the name-agent's business-name candidates) in `llm_calls.purpose`.
 *
 * The name-agent's LLM call is audited through `withLlmLogging` like the extractor and the
 * responder. Without this the KAN-69 CHECK would reject its row and the logger, which
 * swallows persistence errors by design, would silently drop the audit record.
 *
 * Loosening only: the CHECK is replaced by a wider one in the same transaction, so every
 * existing row still satisfies it. `down` restores the narrow list as NOT VALID so rows
 * written with `naming` do not block the rollback.
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check;
    ALTER TABLE llm_calls
      ADD CONSTRAINT llm_calls_purpose_check CHECK (purpose IN ('extractor', 'responder', 'naming'));
    COMMENT ON COLUMN llm_calls.purpose IS
      'Model purpose of the call (extractor, responder or naming). NULL only for rows recorded before KAN-69 provenance.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE llm_calls DROP CONSTRAINT llm_calls_purpose_check;
    ALTER TABLE llm_calls
      ADD CONSTRAINT llm_calls_purpose_check CHECK (purpose IN ('extractor', 'responder')) NOT VALID;
    COMMENT ON COLUMN llm_calls.purpose IS
      'Model purpose of the call (extractor or responder). NULL only for rows recorded before KAN-69 provenance.';
  `);
};
