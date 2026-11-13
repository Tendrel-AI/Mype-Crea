/**
 * D41 global dictionaries: closed vocabularies for `enum` brief fields, versioned data in code.
 * Each one ends with the `OTRO` bucket. The Extractor maps free text to a code; when nothing fits it
 * returns `OTRO` and the raw text is still stored (facts keep both). The user never picks a category.
 * A promotion (new category carved out of OTRO) is a code change: add the label, bump `version`,
 * and apply `planPromotion` to history (`src/repos/dictionary-changes.ts`).
 *
 * Pure: no I/O.
 */
import { canonicalize } from './canonical';

export const OTHER_CODE = 'OTRO';

export interface DictionaryEntry {
  readonly code: string;
  readonly label: string;
}

export interface Dictionary {
  readonly key: string;
  /** `YYYY-MM-DD` of the last change to the list. */
  readonly version: string;
  readonly entries: ReadonlyArray<DictionaryEntry>;
}

/** Codes are derived from labels with `canonicalize`, so a label and its code cannot drift. */
function dictionary(key: string, version: string, labels: ReadonlyArray<string>): Dictionary {
  return Object.freeze({
    key,
    version,
    entries: Object.freeze([...labels, 'Otro'].map((label) => Object.freeze({ code: canonicalize(label), label }))),
  });
}

export const DICTIONARIES: Readonly<Record<string, Dictionary>> = Object.freeze({
  business_category: dictionary('business_category', '2026-11-12', [
    'Alimentos y bebidas', 'Panadería y pastelería', 'Textil y confecciones', 'Calzado y cuero', 'Artesanía',
    'Cosmética y cuidado personal', 'Restaurantes', 'Servicios profesionales', 'Tecnología', 'Agro',
    'Construcción y ferretería', 'Educación', 'Salud', 'Turismo', 'Transporte', 'Comercio minorista',
  ]),
  target_audience: dictionary('target_audience', '2026-11-12', [
    'Jóvenes', 'Familias', 'Mujeres', 'Hombres', 'Adultos mayores', 'Niños', 'Estudiantes',
    'Profesionales', 'Empresas y negocios', 'Turistas', 'Público en general',
  ]),
});

export function dictionaryFor(key: string): Dictionary | undefined {
  return DICTIONARIES[key];
}

export const dictionaryCodes = (dict: Dictionary): string[] => dict.entries.map((e) => e.code);

/**
 * The canonical category of a raw value: the Extractor's pick when it is a code of the list, else the
 * raw text when it already is one, else `OTRO`.
 */
export function resolveCategory(dict: Dictionary, raw: string, pick?: unknown): string {
  const codes = dictionaryCodes(dict);
  if (typeof pick === 'string' && codes.includes(pick)) return pick;
  const own = canonicalize(raw);
  return codes.includes(own) ? own : OTHER_CODE;
}

export interface PromotionInput {
  readonly dictionaryKey: string;
  /** Label of the new category, e.g. «Mascotas»; must already be in the code dictionary. */
  readonly label: string;
  /** Raw texts (any spelling) that now belong to it. */
  readonly texts: ReadonlyArray<string>;
}

export interface PromotionPlan {
  readonly dictionaryKey: string;
  readonly category: string;
  readonly label: string;
  /** Canonical texts of the OTRO rows to re-map (deduplicated, never empty strings). */
  readonly canonicalTexts: ReadonlyArray<string>;
}

/** Pure: validates a dictionary change and produces the remap that the SQL applies to history. */
export function planPromotion(input: PromotionInput): PromotionPlan {
  const dict = dictionaryFor(input.dictionaryKey);
  if (!dict) throw new Error(`Unknown dictionary: ${input.dictionaryKey}`);
  const category = canonicalize(input.label);
  if (category === '') throw new Error('The new category needs a label.');
  // Code-first flow: the label is already in the dictionary (version bumped) when history is re-mapped.
  if (category === OTHER_CODE || !dictionaryCodes(dict).includes(category)) throw new Error(`Category is not in the dictionary: ${category}`);
  const canonicalTexts = [...new Set(input.texts.map(canonicalize).filter((t) => t !== '' && t !== OTHER_CODE))];
  if (canonicalTexts.length === 0) throw new Error('Give at least one text to map.');
  return { dictionaryKey: input.dictionaryKey, category, label: input.label.trim(), canonicalTexts };
}
