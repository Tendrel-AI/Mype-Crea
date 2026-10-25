/**
 * KAN-34 (RF-06) / KAN-65 R2: iteration refinement shape, caps and validation — repository entry.
 *
 * The rule itself has ONE TypeScript definition: `src/core/refinement.ts` (pure, no I/O). This
 * module re-exports it under the names the repository layer has always used, plus the error the
 * refinement repository throws. The same rule is enforced in PostgreSQL by
 * `app.is_valid_refinement(jsonb)` (migration `1792800001000_iteration-refinement-check`);
 * `refinement-rules.test.ts` and the approvals integration suite run the one shared parity
 * fixture through both. Change the core rule, the SQL function and the fixture together.
 */
import type { RefinementErrorCode } from '../core/refinement';

export {
  REFINEMENT_LIMITS,
  REFINEMENT_SNAPSHOT_KEY,
  checkStoredRefinement,
  codePointLength,
  validateRefinement,
  type IterationRefinement,
  type IterationRefinementInput,
  type RefinementErrorCode,
  type RefinementParameterValue,
  type RefinementValidation,
} from '../core/refinement';

/** Thrown by the refinement repository when validation fails; `message` is user-visible. */
export class RefinementValidationError extends Error {
  readonly code: RefinementErrorCode;
  constructor(code: RefinementErrorCode, message: string) {
    super(message);
    this.name = 'RefinementValidationError';
    this.code = code;
  }
}
