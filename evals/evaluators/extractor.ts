/**
 * Deterministic scorers for the Extractor (Layer 1). Pure: they compare a
 * produced `FieldDelta` against a case's expectation and return LangSmith
 * feedback entries (`{ key, score }`, score in [0, 1]).
 *
 * Expectations are written per logical field (the Extractor fans one value
 * out to every agent that owns the field, so the scorer folds the delta back
 * to one value per field name before comparing).
 */
import {
  CONFIDENCE_THRESHOLDS,
  type FieldDelta,
  type FieldValueWithConfidence,
} from '../../src/core/contracts';
import { includesNormalized } from './text';

/** `filled` = ≥ AUTO_ACCEPT; `pending` = STORE_AND_CONFIRM ≤ c < AUTO_ACCEPT. */
export type ConfidenceBucket = 'filled' | 'pending';

export interface ExpectedField {
  /** Every needle must appear in the value (normalized substring match). */
  readonly contains: ReadonlyArray<string>;
  /** None of these may appear in the value (e.g. the name being corrected). */
  readonly notContains?: ReadonlyArray<string>;
  /** Omit when either bucket is acceptable. */
  readonly bucket?: ConfidenceBucket;
  /**
   * May be absent without penalty (not counted in recall/value_match) and is never a
   * hallucination; if present it must still satisfy `contains`/`notContains`.
   */
  readonly optional?: boolean;
}

export interface ExpectedIntent {
  readonly kind: 'reset_field';
  readonly fieldName: string;
}

export interface ExtractorExpectation {
  /**
   * Fields the message grounds. Every field NOT listed here must be absent
   * from the delta: an extra field counts as a hallucination.
   */
  readonly fields: Readonly<Record<string, ExpectedField>>;
  /** Defaults to "no intents". */
  readonly intents?: ReadonlyArray<ExpectedIntent>;
}

export interface Feedback {
  readonly key: string;
  readonly score: number;
  readonly comment?: string;
}

export interface ExtractorScore {
  readonly pass: boolean;
  readonly feedback: ReadonlyArray<Feedback>;
}

export function bucketOf(confidence: number): ConfidenceBucket | 'dropped' {
  if (confidence >= CONFIDENCE_THRESHOLDS.AUTO_ACCEPT) return 'filled';
  if (confidence >= CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM) return 'pending';
  return 'dropped';
}

/** One value per logical field; agents are iterated lexically for stability. */
export function flattenDeltaFields(delta: FieldDelta): Record<string, FieldValueWithConfidence> {
  const out: Record<string, FieldValueWithConfidence> = {};
  for (const agentId of Object.keys(delta.fields).sort()) {
    for (const [fieldName, v] of Object.entries(delta.fields[agentId])) {
      out[fieldName] ??= v;
    }
  }
  return out;
}

export function scoreExtraction(delta: FieldDelta, expected: ExtractorExpectation): ExtractorScore {
  const actual = flattenDeltaFields(delta);
  const expectedNames = Object.keys(expected.fields).filter((n) => !expected.fields[n].optional || n in actual);
  const actualNames = Object.keys(actual);

  const found = expectedNames.filter((n) => n in actual);
  const valueOk = found.filter((n) => valueMatches(String(actual[n].value), expected.fields[n]));
  const bucketChecked = found.filter((n) => expected.fields[n].bucket !== undefined);
  const bucketOk = bucketChecked.filter(
    (n) => bucketOf(actual[n].confidence) === expected.fields[n].bucket,
  );
  const hallucinated = actualNames.filter((n) => !(n in expected.fields));

  const recall = ratio(found.length, expectedNames.length);
  const precision = ratio(valueOk.length, actualNames.length);
  const valueMatch = ratio(valueOk.length, expectedNames.length);
  const confidenceBucket = ratio(bucketOk.length, bucketChecked.length);
  const intentsOk = intentsMatch(delta, expected.intents ?? []);

  const feedback: Feedback[] = [
    { key: 'extractor.recall', score: recall },
    { key: 'extractor.precision', score: precision },
    { key: 'extractor.value_match', score: valueMatch, comment: describeMisses(actual, expectedNames, valueOk) },
    { key: 'extractor.confidence_bucket', score: confidenceBucket },
    {
      key: 'extractor.no_hallucination',
      score: hallucinated.length === 0 ? 1 : 0,
      comment:
        hallucinated.length > 0
          ? `unexpected: ${hallucinated.map((n) => `${n}=${JSON.stringify(actual[n].value)} @${actual[n].confidence}`).join(', ')}`
          : undefined,
    },
    { key: 'extractor.intents', score: intentsOk ? 1 : 0 },
  ];

  const pass =
    valueMatch === 1 && precision === 1 && confidenceBucket === 1 && hallucinated.length === 0 && intentsOk;
  return { pass, feedback };
}

function valueMatches(value: string, exp: ExpectedField): boolean {
  return (
    exp.contains.every((needle) => includesNormalized(value, needle)) &&
    (exp.notContains ?? []).every((needle) => !includesNormalized(value, needle))
  );
}

/** Intents are compared as a set of `kind:fieldName`; agent fan-out is ignored. */
function intentsMatch(delta: FieldDelta, expected: ReadonlyArray<ExpectedIntent>): boolean {
  const actual = new Set(
    (delta.intents ?? []).map((i) => `${i.kind}:${'fieldName' in i ? i.fieldName : ''}`),
  );
  const want = new Set(expected.map((i) => `${i.kind}:${i.fieldName}`));
  return actual.size === want.size && [...want].every((k) => actual.has(k));
}

function ratio(num: number, den: number): number {
  return den === 0 ? 1 : num / den;
}

function describeMisses(
  actual: Record<string, FieldValueWithConfidence>,
  names: ReadonlyArray<string>,
  ok: ReadonlyArray<string>,
): string | undefined {
  const misses = names
    .filter((n) => !ok.includes(n))
    .map((n) => `${n}=${n in actual ? JSON.stringify(actual[n].value) : '∅'}`);
  return misses.length > 0 ? misses.join('; ') : undefined;
}
