/**
 * MYPES Platform — Iteration refinement rule (KAN-28 / KAN-34 / KAN-65 R2)
 * =========================================================================
 *
 * THE single TypeScript definition of the refinement rule. An «Iterar»
 * command may carry short observations anchored to one candidate and
 * iteration-local parameter overrides. They are stored ONLY in the iteration
 * task's `agent_tasks.requirements_snapshot` under the reserved key
 * `refinement` and never touch the brief.
 *
 *   { parameterChanges: {key: string|number|boolean} (≤20 keys, key
 *       ^[A-Za-z][A-Za-z0-9_]{0,63}$, strings ≤200 code points),
 *     observations: string[] (≤5, each 1..500 code points with at least one
 *       non-ASCII-whitespace character),
 *     anchorDeliverableId: lowercase UUID | null }
 *
 * Pure (no I/O; imports only the reserved snapshot key of ./deliverable-inputs), so both the core (command handler, workers) and
 * the repository layer (`src/repos/refinement-rules.ts` re-exports it) use
 * this module. The same rule is enforced in PostgreSQL by
 * `app.is_valid_refinement(jsonb)` (CHECK `agent_tasks_refinement_valid`,
 * migration `1792800001000_iteration-refinement-check`). ONE parity fixture
 * (`src/repos/__tests__/fixtures/refinement-parity-cases.ts`) is run through
 * this rule (`refinement-rules.test.ts`) and through the SQL function
 * (`approvals.integration.test.ts`). Change the rule, the SQL function and
 * the fixture together.
 *
 * Lengths are Unicode code points (PostgreSQL `char_length`), not UTF-16 units.
 */

import { UPSTREAM_SNAPSHOT_KEY } from './deliverable-inputs';

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
  readonly observations: ReadonlyArray<string>;
  /** Candidate (deliverable of the parent task) the observations are anchored to, if any. */
  readonly anchorDeliverableId: string | null;
}

/** Caller input for `validateRefinement`; missing collections default to empty. */
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

export type RefinementCheck =
  | { readonly ok: true; readonly value: IterationRefinement }
  | { readonly ok: false; readonly code: RefinementErrorCode; readonly message: string };

/** Same type under the repository's historical name. */
export type RefinementValidation = RefinementCheck;

/** User-visible copy by error code (neutral Latin-American Spanish, tú). */
export const REFINEMENT_ERROR_MESSAGES: Readonly<Record<RefinementErrorCode, string>> = Object.freeze({
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
});

/** The same copy under the keys the command handler and its tests use. */
export const REFINEMENT_MESSAGES = Object.freeze({
  invalid: REFINEMENT_ERROR_MESSAGES.invalid_shape,
  tooManyParameters: REFINEMENT_ERROR_MESSAGES.too_many_parameters,
  invalidParameter: REFINEMENT_ERROR_MESSAGES.invalid_parameter_key,
  invalidParameterValue: REFINEMENT_ERROR_MESSAGES.invalid_parameter_value,
  parameterTooLong: REFINEMENT_ERROR_MESSAGES.parameter_value_too_long,
  tooManyObservations: REFINEMENT_ERROR_MESSAGES.too_many_observations,
  invalidObservation: REFINEMENT_ERROR_MESSAGES.invalid_observation,
  emptyObservation: REFINEMENT_ERROR_MESSAGES.empty_observation,
  observationTooLong: REFINEMENT_ERROR_MESSAGES.observation_too_long,
  invalidAnchor: REFINEMENT_ERROR_MESSAGES.invalid_anchor,
});

const PARAMETER_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NON_ASCII_WHITESPACE = /[^ \t\n\r\f\v]/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORED_KEYS: ReadonlySet<string> = new Set(['parameterChanges', 'observations', 'anchorDeliverableId']);

/** Unicode code point count (matches PostgreSQL `char_length`). */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: RefinementErrorCode): RefinementCheck {
  return { ok: false, code, message: REFINEMENT_ERROR_MESSAGES[code] };
}

/**
 * The stored-shape rule, mirrored by `app.is_valid_refinement`. No
 * normalization: it judges exactly the value that would be written.
 */
export function checkStoredRefinement(value: unknown): RefinementCheck {
  if (!isPlainObject(value)) return fail('invalid_shape');
  for (const key of Object.keys(value)) {
    if (!STORED_KEYS.has(key)) return fail('invalid_shape');
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
 * Normalize caller input (default empty collections, trim every observation,
 * lowercase the anchor) and validate the result with the stored-shape rule.
 * An observation that is blank after trimming is rejected (`empty_observation`).
 */
export function validateRefinement(input: unknown): RefinementCheck {
  if (!isPlainObject(input)) return fail('invalid_shape');
  for (const key of Object.keys(input)) {
    if (!STORED_KEYS.has(key)) return fail('invalid_shape');
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

/**
 * Build the stored refinement for one «Iterar» command: one optional
 * observation (trimmed; blank -> none), optional parameter overrides, and
 * the anchor candidate. The result is checked with the stored-shape rule, so
 * whatever passes here also passes the database CHECK.
 */
export function buildIterationRefinement(input: {
  readonly observation?: unknown;
  readonly parameterChanges?: unknown;
  readonly anchorDeliverableId: string | null;
}): RefinementCheck {
  let observations: unknown[] = [];
  if (input.observation !== undefined && input.observation !== null) {
    if (typeof input.observation !== 'string') return fail('invalid_shape');
    const trimmed = input.observation.trim();
    if (trimmed.length > 0) observations = [trimmed];
  }
  return checkStoredRefinement({
    parameterChanges: input.parameterChanges ?? {},
    observations,
    anchorDeliverableId:
      typeof input.anchorDeliverableId === 'string' ? input.anchorDeliverableId.toLowerCase() : null,
  });
}

/**
 * Split a persisted requirements snapshot into the handler requirements and
 * the refinement. Workers that rebuild the A2A message from the task row use
 * this so the reserved keys never reach a handler's `requirements`.
 */
export function splitRequirementsSnapshot(snapshot: Readonly<Record<string, unknown>>): {
  readonly requirements: Record<string, unknown>;
  readonly refinement: IterationRefinement | null;
} {
  // The KAN-35 upstream record is bookkeeping for staleness, not handler input.
  const { [REFINEMENT_SNAPSHOT_KEY]: raw, [UPSTREAM_SNAPSHOT_KEY]: _upstream, ...requirements } = snapshot;
  if (raw === undefined) return { requirements, refinement: null };
  const checked = checkStoredRefinement(raw);
  return { requirements, refinement: checked.ok ? checked.value : null };
}
