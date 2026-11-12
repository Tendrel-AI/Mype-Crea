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
  /** Same vocabulary as Agent Card requirement types. Every brief field is text today. */
  readonly type: 'string';
  /** Spanish label shown to the user. */
  readonly label: string;
  /** Maximum length in code points after normalization. */
  readonly maxLength: number;
}

/** Display order: brand first, then product. */
export const BRIEF_CATALOG: ReadonlyArray<BriefFieldSpec> = Object.freeze([
  { name: 'business_name', type: 'string', label: 'Nombre del negocio', maxLength: 120 },
  { name: 'business_category', type: 'string', label: 'Rubro', maxLength: 120 },
  { name: 'market_proposition', type: 'string', label: 'Propuesta de mercado', maxLength: 500 },
  { name: 'target_audience', type: 'string', label: 'Público objetivo', maxLength: 500 },
  { name: 'differentiator', type: 'string', label: 'Diferencial', maxLength: 500 },
  { name: 'personality', type: 'string', label: 'Personalidad y percepción', maxLength: 500 },
  { name: 'brand_story', type: 'string', label: 'Historia de la marca', maxLength: 1000 },
  { name: 'language_references', type: 'string', label: 'Idioma y referencias culturales', maxLength: 500 },
  { name: 'visual_behavior', type: 'string', label: 'Comportamiento visual', maxLength: 500 },
  { name: 'style_keywords', type: 'string', label: 'Estilo', maxLength: 300 },
  { name: 'color_palette', type: 'string', label: 'Colores', maxLength: 200 },
  { name: 'color_description', type: 'string', label: 'Colores (descripción)', maxLength: 200 },
  { name: 'location', type: 'string', label: 'Ubicación', maxLength: 120 },
  { name: 'existing_tagline', type: 'string', label: 'Lema actual', maxLength: 120 },
  // Logo brief (conversation-only, not in the brand catalog).
  { name: 'logo_goal', type: 'string', label: 'Problema que resuelve el logo', maxLength: 500 },
  { name: 'logo_avoid', type: 'string', label: 'Asociaciones a evitar', maxLength: 500 },
  { name: 'competitors', type: 'string', label: 'Competidores y riesgos de confusión', maxLength: 500 },
  { name: 'visual_references', type: 'string', label: 'Referencias visuales', maxLength: 500 },
  { name: 'logo_composition', type: 'string', label: 'Composición del logo', maxLength: 300 },
  { name: 'logo_shapes', type: 'string', label: 'Formas y trazos', maxLength: 500 },
  { name: 'logo_typography', type: 'string', label: 'Tipografía', maxLength: 500 },
  { name: 'logo_keep', type: 'string', label: 'Elementos a conservar', maxLength: 500 },
  { name: 'logo_applications', type: 'string', label: 'Aplicaciones del logo', maxLength: 500 },
  { name: 'logo_production_limits', type: 'string', label: 'Límites de producción', maxLength: 500 },
  { name: 'logo_restrictions', type: 'string', label: 'Elementos obligatorios y prohibidos', maxLength: 500 },
  { name: 'product_name', type: 'string', label: 'Producto', maxLength: 120 },
]);

/**
 * D35: the value a delegable required field (Agent Card `delegable: true`) takes when the user leaves it to the
 * agent. The ONE definition: the chat adapter stores it, the command snapshot sends it, the agent prompt reads it.
 */
export const DELEGATED_FIELD_VALUE = 'A criterio del diseñador';

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
  return briefFieldSpec(name) ?? { name, type: 'string', label: name, maxLength: UNCATALOGED_MAX_LENGTH };
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
export function validateBriefValue(spec: BriefFieldSpec, value: unknown): BriefValueResult {
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
