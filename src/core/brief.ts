/**
 * MYPES Platform — Brief catalog (KAN-26)
 * ========================================
 *
 * The ONE definition of the brief fields a user can give in chat or edit in
 * the brief panel: name, type, validation, and Spanish label. Merge applies
 * `validateBriefValue` to every catalog field, so chat and panel values are
 * normalized and validated by the same rule. KAN-44 reuses this list to
 * reject unknown fields.
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
  { name: 'style_keywords', type: 'string', label: 'Estilo', maxLength: 300 },
  { name: 'color_palette', type: 'string', label: 'Colores', maxLength: 200 },
  { name: 'product_name', type: 'string', label: 'Producto', maxLength: 120 },
  { name: 'product_composition', type: 'string', label: 'Composición', maxLength: 500 },
  { name: 'product_presentation', type: 'string', label: 'Presentación', maxLength: 200 },
  { name: 'manufacturer', type: 'string', label: 'Fabricante', maxLength: 120 },
]);

export function briefFieldSpec(name: string): BriefFieldSpec | undefined {
  return BRIEF_CATALOG.find((field) => field.name === name);
}

export type BriefValueResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

/**
 * Normalize and validate one value for a catalog field: control characters
 * and runs of whitespace become one space, the result is trimmed, and it must
 * be 1..maxLength code points. Messages are neutral Spanish (tú).
 */
export function validateBriefValue(spec: BriefFieldSpec, value: unknown): BriefValueResult {
  if (typeof value !== 'string') return { ok: false, message: 'No pudimos validar este dato.' };
  const normalized = value.normalize('NFC').replace(/[\p{Cc}\s]+/gu, ' ').trim();
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
