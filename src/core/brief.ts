/**
 * MYPES Platform — Brief catalog (KAN-26)
 * ========================================
 *
 * The ONE definition of the brief fields a user can give in chat or edit in
 * the brief panel: name, type, validation, and Spanish label. Merge applies
 * `validateBriefValue` to every catalog field, so chat and panel values are
 * normalized and validated by the same rule. KAN-44: merge accepts only a
 * catalog field or a field a registered Agent Card declares, and validates
 * both (`fieldRule`); the panel accepts only catalog fields.
 *
 * Field names match the Agent Cards that own them (`agents/<id>/agent-card.json`);
 * a test checks that the default registry owns every catalog field and that
 * every field it declares is in the catalog. Nutrition is out of scope (KAN-37).
 *
 * Pure: no I/O, no adapters, no channel knowledge.
 */

import type { AdapterSource, ConversationSnapshot, FieldName, FieldSlot } from './contracts';

export interface BriefFieldSpec {
  readonly name: FieldName;
  /** Same vocabulary as Agent Card requirement types. `enum` = closed list (D41): the value stays free text, the category comes from the dictionary. */
  readonly type: 'string' | 'enum';
  /** `enum` only: key in `DICTIONARIES` (src/core/dictionaries). */
  readonly vocabulary?: string;
  /** D41: how the org analytics reads this field (counts per canonical value, fill rate only, or not at all). */
  readonly analytics: 'category' | 'tags' | 'text' | 'none';
  /** D41: `YYYY-MM-DD`. A deprecated field is no longer asked (planner/Extractor) but keeps its data and stays in the panel. */
  readonly deprecatedSince?: string;
  /** Spanish label shown to the user. */
  readonly label: string;
  /** Maximum length in code points after normalization. */
  readonly maxLength: number;
}

/** Display order: brand first, then product. */
export const BRIEF_CATALOG: ReadonlyArray<BriefFieldSpec> = Object.freeze([
  { name: 'business_name', type: 'string', analytics: 'none', label: 'Nombre del negocio', maxLength: 120 },
  { name: 'business_category', type: 'enum', vocabulary: 'business_category', analytics: 'category', label: 'Rubro', maxLength: 120 },
  { name: 'market_proposition', type: 'string', analytics: 'text', label: 'Propuesta de mercado', maxLength: 500 },
  { name: 'target_audience', type: 'enum', vocabulary: 'target_audience', analytics: 'category', label: 'Público objetivo', maxLength: 500 },
  { name: 'differentiator', type: 'string', analytics: 'text', label: 'Diferencial', maxLength: 500 },
  { name: 'personality', type: 'string', analytics: 'text', label: 'Personalidad y percepción', maxLength: 500 },
  { name: 'brand_story', type: 'string', analytics: 'text', label: 'Historia de la marca', maxLength: 1000 },
  { name: 'language_references', type: 'string', analytics: 'text', label: 'Idioma y referencias culturales', maxLength: 500 },
  { name: 'visual_behavior', type: 'string', analytics: 'text', label: 'Comportamiento visual', maxLength: 500 },
  { name: 'style_keywords', type: 'string', analytics: 'tags', label: 'Estilo', maxLength: 300 },
  { name: 'color_palette', type: 'string', analytics: 'tags', label: 'Colores', maxLength: 200 },
  { name: 'color_description', type: 'string', analytics: 'text', label: 'Colores (descripción)', maxLength: 200 },
  { name: 'location', type: 'string', analytics: 'text', label: 'Ubicación', maxLength: 120 },
  { name: 'existing_tagline', type: 'string', analytics: 'text', label: 'Lema actual', maxLength: 120 },
  // Logo brief (conversation-only, not in the brand catalog).
  { name: 'logo_goal', type: 'string', analytics: 'text', label: 'Problema que resuelve el logo', maxLength: 500 },
  { name: 'logo_avoid', type: 'string', analytics: 'text', label: 'Asociaciones a evitar', maxLength: 500 },
  { name: 'competitors', type: 'string', analytics: 'text', label: 'Competidores y riesgos de confusión', maxLength: 500 },
  { name: 'visual_references', type: 'string', analytics: 'text', label: 'Referencias visuales', maxLength: 500 },
  { name: 'logo_composition', type: 'string', analytics: 'text', label: 'Composición del logo', maxLength: 300 },
  { name: 'logo_shapes', type: 'string', analytics: 'text', label: 'Formas y trazos', maxLength: 500 },
  { name: 'logo_typography', type: 'string', analytics: 'text', label: 'Tipografía', maxLength: 500 },
  { name: 'logo_keep', type: 'string', analytics: 'text', label: 'Elementos a conservar', maxLength: 500 },
  { name: 'logo_applications', type: 'string', analytics: 'text', label: 'Aplicaciones del logo', maxLength: 500 },
  { name: 'logo_production_limits', type: 'string', analytics: 'text', label: 'Límites de producción', maxLength: 500 },
  { name: 'logo_restrictions', type: 'string', analytics: 'text', label: 'Elementos obligatorios y prohibidos', maxLength: 500 },
  { name: 'product_name', type: 'string', analytics: 'text', label: 'Producto', maxLength: 120 },
]);

/**
 * D35: the value a delegable required field (Agent Card `delegable: true`) takes when the user leaves it to the
 * agent. The ONE definition: the chat adapter stores it, the command snapshot sends it, the agent prompt reads it.
 */
export const DELEGATED_FIELD_VALUE = 'A criterio del diseñador';

/** D41: version stamped on every fact. Bump it (`YYYY-MM-DD`) whenever a catalog field is added, retyped or deprecated. */
export const BRIEF_CATALOG_VERSION = '2026-11-12';

/** D41: a deprecated field is not asked any more; its data and its analytics section stay. */
export function isDeprecatedField(name: string, catalog: ReadonlyArray<BriefFieldSpec> = BRIEF_CATALOG): boolean {
  return catalog.some((f) => f.name === name && f.deprecatedSince !== undefined);
}

export function briefFieldSpec(name: string): BriefFieldSpec | undefined {
  return BRIEF_CATALOG.find((field) => field.name === name);
}

/** Max length of a field a registered Agent Card declares outside the catalog (KAN-44). */
const UNCATALOGED_MAX_LENGTH = 500;

/**
 * The validation rule merge applies to a field the registry already accepted:
 * the catalog spec, or plain text for a card field outside the catalog (KAN-44).
 */
export function fieldRule(name: string): BriefFieldSpec {
  return briefFieldSpec(name) ?? { name, type: 'string', analytics: 'none', label: name, maxLength: UNCATALOGED_MAX_LENGTH };
}

export type BriefValueResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

/**
 * Normalize and validate one value for a catalog field: control characters
 * other than tab and line breaks are rejected (KAN-44), runs of whitespace
 * become one space, the result is trimmed, and it must be 1..maxLength code
 * points. Messages are neutral Spanish (tú).
 */
export function validateBriefValue(spec: Pick<BriefFieldSpec, 'name' | 'type' | 'label' | 'maxLength'>, value: unknown): BriefValueResult {
  if (typeof value !== 'string') return { ok: false, message: 'No pudimos validar este dato.' };
  if (/[^\P{Cc}\t\n\r]/u.test(value)) return { ok: false, message: `«${spec.label}» tiene caracteres no permitidos.` };
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return { ok: false, message: `Escribe un valor para «${spec.label}».` };
  if ([...normalized].length > spec.maxLength) {
    return { ok: false, message: `«${spec.label}» puede tener hasta ${spec.maxLength} caracteres.` };
  }
  return { ok: true, value: normalized };
}

export interface BriefFieldView {
  readonly name: FieldName;
  readonly label: string;
  readonly maxLength: number;
  readonly status: FieldSlot['status'];
  readonly value: string | null;
  /** `FieldDelta.source` of the accepted value (audit only); null for empty or legacy slots. */
  readonly source: AdapterSource | null;
}

/**
 * The brief as the user sees it: one entry per catalog field, in catalog
 * order. A field shared by several agents holds the same value on each (the
 * input side fans it out), so the first non-empty slot in agent order wins.
 */
export function briefFromSnapshot(snapshot: ConversationSnapshot): ReadonlyArray<BriefFieldView> {
  const agentIds = Object.keys(snapshot.agentStates).sort();
  return BRIEF_CATALOG.map((spec) => {
    let slot: FieldSlot = { status: 'empty' };
    for (const agentId of agentIds) {
      const state = snapshot.agentStates[agentId];
      const candidate = state.requiredFields[spec.name] ?? state.optionalFields[spec.name];
      if (candidate && candidate.status !== 'empty') {
        slot = candidate;
        break;
      }
    }
    return {
      name: spec.name,
      label: spec.label,
      maxLength: spec.maxLength,
      status: slot.status,
      value: slot.status === 'empty' ? null : String(slot.value),
      source: slot.status === 'empty' ? null : slot.source ?? null,
    };
  });
}
