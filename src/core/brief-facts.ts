/**
 * D41 brief facts: how one persisted field value becomes a normalized fact row.
 * Pure: the repo (`src/repos/brief-facts.ts`) only inserts what this returns.
 *
 *  - `rawValue`: what is stored in the brief.
 *  - `rawCanonical`: `canonicalize(raw)`; what an OTRO promotion matches on.
 *  - `canonicalValue`: enum -> dictionary code (`OTRO` when nothing fits); tags -> sorted-by-appearance
 *    canonical tags joined by `,`; category/text -> `rawCanonical`.
 */
import { briefFieldSpec, DELEGATED_FIELD_VALUE, type BriefFieldSpec } from './brief';
import { canonicalize } from './dictionaries/canonical';
import { dictionaryFor, resolveCategory } from './dictionaries';

export interface BriefFactDraft {
  readonly fieldName: string;
  readonly rawValue: string;
  readonly rawCanonical: string;
  readonly canonicalValue: string;
  readonly dictionaryVersion: string | null;
}

export const TAG_SEPARATOR = ',';
const TAG_SPLIT = /[,;/]/u;

export function factFor(spec: BriefFieldSpec, value: unknown, category?: unknown): BriefFactDraft | undefined {
  if (spec.analytics === 'none' || typeof value !== 'string' || value === DELEGATED_FIELD_VALUE) return undefined;
  const rawCanonical = canonicalize(value);
  if (rawCanonical === '') return undefined;
  const dict = spec.type === 'enum' && spec.vocabulary ? dictionaryFor(spec.vocabulary) : undefined;
  const canonicalValue = dict
    ? resolveCategory(dict, value, category)
    : spec.analytics === 'tags'
      ? [...new Set(value.split(TAG_SPLIT).map(canonicalize).filter((t) => t !== ''))].join(TAG_SEPARATOR)
      : rawCanonical;
  return { fieldName: spec.name, rawValue: value, rawCanonical, canonicalValue, dictionaryVersion: dict?.version ?? null };
}

/** Fact for a catalog field by name; undefined for fields outside the catalog. */
export function factForField(fieldName: string, value: unknown, category?: unknown): BriefFactDraft | undefined {
  const spec = briefFieldSpec(fieldName);
  return spec ? factFor(spec, value, category) : undefined;
}
