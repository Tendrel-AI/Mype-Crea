/**
 * KAN-34 (RF-06) / KAN-65 R2: iteration refinement shape, caps and validation.
 *
 * Pure module (no I/O). The same rule is enforced in PostgreSQL by
 * `app.is_valid_refinement(jsonb)` (migration `1792800001000_iteration-refinement-check`);
 * `refinement-rules.test.ts` and the approvals integration suite run the same parity cases
 * through both. Change both together.
 *
 * Lengths are counted in Unicode code points, which is what PostgreSQL `char_length` counts
 * (JavaScript `string.length` counts UTF-16 units and would disagree on emoji).
 */

export const REFINEMENT_LIMITS = Object.freeze({
  maxObservations: 5,
  maxObservationChars: 500,
  maxParameterChanges: 20,
  maxParameterKeyChars: 64,
  maxParameterStringChars: 200,
});

/** Reserved `requirements_snapshot` key that carries the iteration-local refinement. */
export const REFINEMENT_SNAPSHOT_KEY = 'refinement';

export type RefinementParameterValue = string | number | boolean;

/** Stored shape (`requirements_snapshot.refinement`). */
export interface IterationRefinement {
  readonly parameterChanges: Readonly<Record<string, RefinementParameterValue>>;
  readonly observations: readonly string[];
  /** Candidate (deliverable of the parent task) the observations are anchored to, if any. */
  readonly anchorDeliverableId: string | null;
}

/** Caller input; missing collections default to empty. */
export interface IterationRefinementInput {
  readonly parameterChanges?: Readonly<Record<string, unknown>>;
  readonly observations?: readonly unknown[];
  readonly anchorDeliverableId?: string | null;
}

export type RefinementErrorCode =
  | 'invalid_shape'
  | 'too_many_parameters'
  | 'invalid_parameter_key'
  | 'invalid_parameter_value'
  | 'parameter_value_too_long'
  | 'too_many_observations'
  | 'invalid_observation'
  | 'empty_observation'
  | 'observation_too_long'
  | 'invalid_anchor';

export type RefinementValidation =
  | { readonly ok: true; readonly value: IterationRefinement }
  | { readonly ok: false; readonly code: RefinementErrorCode; readonly message: string };

/** User-visible copy: neutral Latin-American Spanish, tú. */
const MESSAGES: Readonly<Record<RefinementErrorCode, string>> = {
  invalid_shape: 'No pudimos leer los cambios que pediste. Inténtalo de nuevo.',
  too_many_parameters: `Puedes ajustar como máximo ${REFINEMENT_LIMITS.maxParameterChanges} opciones a la vez.`,
  invalid_parameter_key: 'Una de las opciones que ajustaste no es válida.',
  invalid_parameter_value: 'Uno de los valores que elegiste no es válido.',
  parameter_value_too_long: `Cada valor puede tener hasta ${REFINEMENT_LIMITS.maxParameterStringChars} caracteres.`,
  too_many_observations: `Puedes escribir como máximo ${REFINEMENT_LIMITS.maxObservations} observaciones.`,
  invalid_observation: 'Cada observación debe ser un texto.',
  empty_observation: 'Escribe qué quieres cambiar antes de enviar la observación.',
  observation_too_long: `Cada observación puede tener hasta ${REFINEMENT_LIMITS.maxObservationChars} caracteres.`,
  invalid_anchor: 'La propuesta que elegiste para iterar no es válida.',
};

const PARAMETER_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NON_ASCII_WHITESPACE = /[^ \t\n\r\f\v]/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Unicode code point count (matches PostgreSQL `char_length`). */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function fail(code: RefinementErrorCode): RefinementValidation {
  return { ok: false, code, message: MESSAGES[code] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The stored-shape rule, mirrored by `app.is_valid_refinement`. No normalization: it judges
 * exactly the value that would be written.
 */
export function checkStoredRefinement(value: unknown): RefinementValidation {
  if (!isPlainObject(value)) return fail('invalid_shape');
  for (const key of Object.keys(value)) {
    if (key !== 'parameterChanges' && key !== 'observations' && key !== 'anchorDeliverableId') {
      return fail('invalid_shape');
    }
  }
  const { parameterChanges, observations } = value;
  if (!isPlainObject(parameterChanges) || !Array.isArray(observations)) return fail('invalid_shape');

  const entries = Object.entries(parameterChanges);
  if (entries.length > REFINEMENT_LIMITS.maxParameterChanges) return fail('too_many_parameters');
  for (const [key, v] of entries) {
    if (!PARAMETER_KEY.test(key)) return fail('invalid_parameter_key');
    if (typeof v === 'string') {
      if (v.includes('\u0000')) return fail('invalid_parameter_value');
      if (codePointLength(v) > REFINEMENT_LIMITS.maxParameterStringChars) {
        return fail('parameter_value_too_long');
      }
    } else if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
      return fail('invalid_parameter_value');
    }
  }

  if (observations.length > REFINEMENT_LIMITS.maxObservations) return fail('too_many_observations');
  for (const o of observations) {
    // PostgreSQL text/jsonb cannot store NUL, so it is rejected here rather than at INSERT.
    if (typeof o !== 'string' || o.includes('\u0000')) return fail('invalid_observation');
    const len = codePointLength(o);
    if (len === 0 || !NON_ASCII_WHITESPACE.test(o)) return fail('empty_observation');
    if (len > REFINEMENT_LIMITS.maxObservationChars) return fail('observation_too_long');
  }

  const anchor = value.anchorDeliverableId;
  if (anchor !== undefined && anchor !== null) {
    if (typeof anchor !== 'string' || !LOWER_UUID.test(anchor)) return fail('invalid_anchor');
  }

  return {
    ok: true,
    value: {
      parameterChanges: Object.fromEntries(entries) as Record<string, RefinementParameterValue>,
      observations: [...(observations as string[])],
      anchorDeliverableId: (anchor as string | null | undefined) ?? null,
    },
  };
}

/**
 * Normalize caller input (default empty collections, trim observations, lowercase the anchor)
 * and validate the result with the stored-shape rule.
 */
export function validateRefinement(input: unknown): RefinementValidation {
  if (!isPlainObject(input)) return fail('invalid_shape');
  for (const key of Object.keys(input)) {
    if (key !== 'parameterChanges' && key !== 'observations' && key !== 'anchorDeliverableId') {
      return fail('invalid_shape');
    }
  }
  const parameterChanges = input.parameterChanges ?? {};
  const rawObservations = input.observations ?? [];
  if (!Array.isArray(rawObservations)) return fail('invalid_shape');
  const observations = rawObservations.map((o) => (typeof o === 'string' ? o.trim() : o));
  const anchor = input.anchorDeliverableId;
  return checkStoredRefinement({
    parameterChanges,
    observations,
    anchorDeliverableId: typeof anchor === 'string' ? anchor.toLowerCase() : (anchor ?? null),
  });
}

/** Thrown by the refinement repository when validation fails; `message` is user-visible. */
export class RefinementValidationError extends Error {
  readonly code: RefinementErrorCode;
  constructor(code: RefinementErrorCode, message: string) {
    super(message);
    this.name = 'RefinementValidationError';
    this.code = code;
  }
}
