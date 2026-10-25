/**
 * KAN-69 (A6 / gap G4): record the effective provider and the purpose on every llm_calls row.
 *
 * `ai_turn_attempts` already keeps provider/model/purpose per attempt, but the
 * append-only `llm_calls` billing/audit log only kept model and tokens, so a row could not
 * say which provider actually served it or whether it was an extractor or responder call.
 *
 * Column design:
 *  - `provider` text, CHECK IN ('openrouter', 'anthropic'): the `ProviderId` values in
 *    `src/services/ai-config/manifest.ts` (same list as ai_model_profiles/ai_turn_attempts).
 *  - `purpose` text, CHECK IN ('extractor', 'responder'): the `Purpose`/`ModelPurpose`
 *    values. Judge calls are eval cost and deliberately never reach llm_calls.
 *  - Both columns are nullable at the type level and are NOT backfilled. Rows written before
 *    this migration carry no trustworthy provenance: the provider could only be guessed
 *    from the model ID shape and the purpose not at all, and an audit table must not
 *    fabricate it. NULL there honestly means "recorded before provenance existed".
 *  - `llm_calls_provenance_required` (CHECK both NOT NULL) is added NOT VALID: PostgreSQL
 *    enforces it for every new or updated row but does not validate pre-existing rows, so
 *    all rows written from now on must carry provider and purpose while legacy rows stay
 *    readable. pg_dump restores NOT VALID checks after the data, so backups keep working.
 *
 * RLS, the `llm_calls_tenant` policy, grants and indexes are untouched: adding columns
 * keeps FORCE RLS and the app_user table grant (INSERT/SELECT apply to new columns).
 */

export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE llm_calls
      ADD COLUMN provider text
        CONSTRAINT llm_calls_provider_check CHECK (provider IN ('openrouter', 'anthropic')),
      ADD COLUMN purpose text
        CONSTRAINT llm_calls_purpose_check CHECK (purpose IN ('extractor', 'responder'));

    ALTER TABLE llm_calls
      ADD CONSTRAINT llm_calls_provenance_required
        CHECK (provider IS NOT NULL AND purpose IS NOT NULL) NOT VALID;

    COMMENT ON COLUMN llm_calls.provider IS
      'Effective provider that served the call. NULL only for rows recorded before KAN-69 provenance.';
    COMMENT ON COLUMN llm_calls.purpose IS
      'Model purpose of the call (extractor or responder). NULL only for rows recorded before KAN-69 provenance.';
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_provenance_required;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS purpose;
    ALTER TABLE llm_calls DROP COLUMN IF EXISTS provider;
  `);
};
