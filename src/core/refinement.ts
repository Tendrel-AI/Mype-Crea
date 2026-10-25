/**
 * MYPES Platform — Iteration refinement rule, core side (KAN-28 / KAN-34 / KAN-65 R2)
 * ====================================================================================
 *
 * An «Iterar» command may carry short observations anchored to one candidate
 * and iteration-local parameter overrides. They are stored ONLY in the
 * iteration task's `agent_tasks.requirements_snapshot` under the reserved key
 * `refinement` and never touch the brief.
 *
 * Shape and caps are the KAN-34 rule (src/repos/refinement-rules.ts and the
 * PostgreSQL CHECK `app.is_valid_refinement`, on `developer` since 45e9b26):
 *
 *   { parameterChanges: {key: string|number|boolean} (≤20 keys, key
 *       ^[A-Za-z][A-Za-z0-9_]{0,63}$, strings ≤200 code points),
 *     observations: string[] (≤5, each 1..500 code points with at least one
 *       non-ASCII-whitespace character),
 *     anchorDeliverableId: lowercase UUID | null }
 *
 * TEMPORARY MIRROR: this branch predates KAN-34, so the core cannot import
 * that module yet (and the core must not import repositories). The cases in
 * `__tests__/refinement.test.ts` are the KAN-34 parity cases verbatim, so the
 * two TypeScript copies agree with each other and with the SQL CHECK. Follow-up
 * at merge: keep ONE TypeScript definition (here, in the core) and have the
 * repository import it.
 *
 * Lengths are Unicode code points (PostgreSQL `char_length`), not UTF-16 units.
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
  readonly observations: ReadonlyArray<string>;
  readonly anchorDeliverableId: string | null;
}

export type RefinementCheck =
  | { readonly ok: true; readonly value: IterationRefinement }
  | { readonly ok: false; readonly message: string };

/** User-visible copy (neutral Latin-American Spanish, tú). */
export const REFINEMENT_MESSAGES = {
  invalid: 'No pudimos leer los cambios que pediste. Inténtalo de nuevo.',
  tooManyParameters: `Puedes ajustar como máximo ${REFINEMENT_LIMITS.maxParameterChanges} opciones a la vez.`,
  invalidParameter: 'Una de las opciones que ajustaste no es válida.',
  invalidParameterValue: 'Uno de los valores que elegiste no es válido.',
  parameterTooLong: `Cada valor puede tener hasta ${REFINEMENT_LIMITS.maxParameterStringChars} caracteres.`,
  tooManyObservations: `Puedes escribir como máximo ${REFINEMENT_LIMITS.maxObservations} observaciones.`,
  invalidObservation: 'Cada observación debe ser un texto.',
  emptyObservation: 'Escribe qué quieres cambiar antes de enviar la observación.',
  observationTooLong: `Cada observación puede tener hasta ${REFINEMENT_LIMITS.maxObservationChars} caracteres.`,
  invalidAnchor: 'La propuesta que elegiste para iterar no es válida.',
} as const;

const PARAMETER_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NON_ASCII_WHITESPACE = /[^ \t\n\r\f\v]/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Unicode code point count (matches PostgreSQL `char_length`). */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fail = (message: string): RefinementCheck => ({ ok: false, message });

/** The stored-shape rule. Judges exactly the value that would be written. */
export function checkStoredRefinement(value: unknown): RefinementCheck {
  if (!isPlainObject(value)) return fail(REFINEMENT_MESSAGES.invalid);
  for (const key of Object.keys(value)) {
    if (key !== 'parameterChanges' && key !== 'observations' && key !== 'anchorDeliverableId') {
      return fail(REFINEMENT_MESSAGES.invalid);
    }
  }
  const { parameterChanges, observations } = value;
  if (!isPlainObject(parameterChanges) || !Array.isArray(observations)) return fail(REFINEMENT_MESSAGES.invalid);

  const entries = Object.entries(parameterChanges);
  if (entries.length > REFINEMENT_LIMITS.maxParameterChanges) return fail(REFINEMENT_MESSAGES.tooManyParameters);
  for (const [key, v] of entries) {
    if (!PARAMETER_KEY.test(key)) return fail(REFINEMENT_MESSAGES.invalidParameter);
    if (typeof v === 'string') {
      if (v.includes('\u0000')) return fail(REFINEMENT_MESSAGES.invalidParameterValue);
      if (codePointLength(v) > REFINEMENT_LIMITS.maxParameterStringChars) {
        return fail(REFINEMENT_MESSAGES.parameterTooLong);
      }
    } else if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
      return fail(REFINEMENT_MESSAGES.invalidParameterValue);
    }
  }

  if (observations.length > REFINEMENT_LIMITS.maxObservations) return fail(REFINEMENT_MESSAGES.tooManyObservations);
  for (const o of observations) {
    if (typeof o !== 'string' || o.includes('\u0000')) return fail(REFINEMENT_MESSAGES.invalidObservation);
    const len = codePointLength(o);
    if (len === 0 || !NON_ASCII_WHITESPACE.test(o)) return fail(REFINEMENT_MESSAGES.emptyObservation);
    if (len > REFINEMENT_LIMITS.maxObservationChars) return fail(REFINEMENT_MESSAGES.observationTooLong);
  }

  const anchor = value.anchorDeliverableId;
  if (anchor !== undefined && anchor !== null) {
    if (typeof anchor !== 'string' || !LOWER_UUID.test(anchor)) return fail(REFINEMENT_MESSAGES.invalidAnchor);
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
    if (typeof input.observation !== 'string') return fail(REFINEMENT_MESSAGES.invalid);
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
 * this so the reserved key never reaches a handler's `requirements`.
 */
export function splitRequirementsSnapshot(snapshot: Readonly<Record<string, unknown>>): {
  readonly requirements: Record<string, unknown>;
  readonly refinement: IterationRefinement | null;
} {
  const { [REFINEMENT_SNAPSHOT_KEY]: raw, ...requirements } = snapshot;
  if (raw === undefined) return { requirements, refinement: null };
  const checked = checkStoredRefinement(raw);
  return { requirements, refinement: checked.ok ? checked.value : null };
}
