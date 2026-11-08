/**
 * KAN-88 brief <-> brand/product record mapping (decision D24: the records are the source of truth).
 *
 * One pure table says which brief fields live on a brand or product record, how a record value shows
 * in the brief (`toBrief`) and what a confirmed brief value writes back (`fromBrief`, a patch in the
 * catalog's input form, validated by `validateAttributes` with `partial: true`). Any brief/card field
 * not listed here (e.g. `product_description`) is conversation-local. Product-level fields in a
 * brand conversation (no product) are conversation-local too.
 *
 * Pure: no I/O, no branching on `FieldDelta.source`; the repo calls these helpers.
 */
import { MAX_PRESENTATIONS, NAME_PENDING_KEY, type AttributeLevel, type Presentation } from './brand-catalog';
import { CONFIDENCE_THRESHOLDS, type AdapterSource, type AgentRequirementState, type FieldSlot } from './contracts';

export type Attrs = Readonly<Record<string, unknown>>;
export type BriefOrigin = 'brand' | 'product' | 'conversation';

export interface RecordContext {
  readonly brand: Attrs;
  readonly product?: Attrs;
}

export interface RecordMapping {
  /** Record that stores the value (and receives the write-back). */
  readonly level: AttributeLevel;
  readonly toBrief: (ctx: RecordContext) => string | undefined;
  /** Patch for the record at `level`; `current` are its stored attributes. */
  readonly fromBrief: (value: string, current: Attrs) => Record<string, unknown>;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const presentations = (v: unknown): Presentation[] =>
  Array.isArray(v) ? v.filter((p): p is Presentation => typeof p?.label === 'string').map((p) => ({ label: p.label, principal: p.principal === true })) : [];

const plain = (key: string, level: AttributeLevel): RecordMapping => ({
  level,
  toBrief: (ctx) => text((level === 'brand' ? ctx.brand : ctx.product)?.[key]),
  fromBrief: (value) => ({ [key]: value }),
});

function colorsToBrief({ brand, product }: RecordContext): string | undefined {
  const own = product?.color_palette;
  const hexes = (Array.isArray(own) && own.length > 0 ? own : Array.isArray(brand.color_palette) ? brand.color_palette : [])
    .filter((c): c is string => typeof c === 'string');
  return [hexes.join(', '), text(brand.color_description)].filter(Boolean).join(', ') || undefined;
}

const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;

/** Hex tokens (#rgb/#rrggbb, as #RRGGBB, deduplicated) go to the palette; the leftover text to the description. */
function colorsFromBrief(value: string): Record<string, unknown> {
  const hexes = [...new Set((value.match(HEX) ?? []).map((h) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join('')}` : h).toUpperCase()))];
  const rest = value.replace(HEX, ' ').replace(/\s*[,;]\s*(?:[,;]\s*)+/g, ', ').replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/\s+/g, ' ');
  // '' clears the optional description in `validateAttributes`.
  return hexes.length > 0 ? { color_palette: hexes, color_description: rest } : { color_description: rest };
}

function presentationFromBrief(value: string, current: Attrs): Record<string, unknown> {
  const items = presentations(current.product_presentations);
  const wanted = value.toLowerCase();
  const known = items.findIndex((p) => p.label.toLowerCase() === wanted);
  let next: Presentation[];
  if (known >= 0) next = items.map((p, i) => ({ ...p, principal: i === known }));
  else if (items.length < MAX_PRESENTATIONS) next = [...items.map((p) => ({ ...p, principal: false })), { label: value, principal: true }];
  // At the cap a new label is not applied: replacing the principal's label would overwrite the owner's data.
  else return {};
  return { product_presentations: next };
}

export const BRIEF_RECORD_MAPPINGS: Readonly<Record<string, RecordMapping>> = Object.freeze({
  business_name: {
    level: 'brand',
    // A pending name means «no business name yet»: the slot stays empty (F12 flow).
    toBrief: ({ brand }) => (brand[NAME_PENDING_KEY] === true ? undefined : text(brand.business_name)),
    // The catalog keeps `brands.name` in sync and drops name_pending (`validateAttributes`).
    fromBrief: (value) => ({ business_name: value, [NAME_PENDING_KEY]: false }),
  },
  business_category: plain('business_category', 'brand'),
  style_keywords: plain('style_keywords', 'brand'),
  // Hex codes in the text go to the palette, the rest to `color_description`; a product override only affects reading.
  color_palette: { level: 'brand', toBrief: colorsToBrief, fromBrief: colorsFromBrief },
  product_name: plain('product_name', 'product'),
  product_composition: plain('product_composition', 'product'),
  manufacturer: plain('manufacturer', 'product'),
  product_presentation: {
    level: 'product',
    toBrief: ({ product }) => presentations(product?.product_presentations).find((p) => p.principal)?.label,
    fromBrief: presentationFromBrief,
  },
});

export interface ConversationLinks {
  readonly hasBrand: boolean;
  readonly hasProduct: boolean;
}

/** The mapping that applies to `field` in a conversation with these links, else undefined (conversation-local). */
export function mappingFor(field: string, links: ConversationLinks): RecordMapping | undefined {
  const mapping = Object.hasOwn(BRIEF_RECORD_MAPPINGS, field) ? BRIEF_RECORD_MAPPINGS[field] : undefined;
  if (!mapping) return undefined;
  return (mapping.level === 'brand' ? links.hasBrand : links.hasProduct) ? mapping : undefined;
}

export function briefOrigin(field: string, links: ConversationLinks): BriefOrigin {
  return mappingFor(field, links)?.level ?? 'conversation';
}

/**
 * Overlay record values on a snapshot's slots: a mapped field with a record value becomes `filled` (the
 * record wins over a stored value or a pending confirmation); without a record value the slot is kept.
 * Confidence is AUTO_ACCEPT, so a later chat value at that confidence or higher can still replace it.
 */
export function overlayRecords<S extends Record<string, AgentRequirementState>>(
  agentStates: S,
  ctx: RecordContext,
  source: AdapterSource,
): S {
  const links = { hasBrand: true, hasProduct: ctx.product !== undefined };
  const overlay = (slots: Readonly<Record<string, FieldSlot>>): Record<string, FieldSlot> =>
    Object.fromEntries(Object.entries(slots).map(([name, slot]) => {
      const value = mappingFor(name, links)?.toBrief(ctx);
      return [name, value === undefined ? slot : { status: 'filled', value, confidence: CONFIDENCE_THRESHOLDS.AUTO_ACCEPT, source }];
    }));
  return Object.fromEntries(Object.entries(agentStates).map(([id, state]) => [
    id,
    { ...state, requiredFields: overlay(state.requiredFields), optionalFields: overlay(state.optionalFields) },
  ])) as S;
}

/** Brief fields that are `filled` in `next` with a value different from what was stored, first agent (sorted) wins. */
export function filledChanges(
  previous: Readonly<Record<string, AgentRequirementState>>,
  next: Readonly<Record<string, AgentRequirementState>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of Object.keys(next).sort()) {
    for (const key of ['requiredFields', 'optionalFields'] as const) {
      for (const [name, slot] of Object.entries(next[id][key])) {
        if (slot.status !== 'filled' || out.has(name) || typeof slot.value !== 'string') continue;
        const before = previous[id]?.[key]?.[name];
        if (before?.status === 'filled' && before.value === slot.value) continue;
        out.set(name, slot.value);
      }
    }
  }
  return out;
}

/** Mapped fields that were `filled` and are no longer: a panel/reset clear never deletes the record value. */
export function clearedFields(
  previous: Readonly<Record<string, AgentRequirementState>>,
  next: Readonly<Record<string, AgentRequirementState>>,
): string[] {
  const out = new Set<string>();
  for (const id of Object.keys(previous)) {
    for (const key of ['requiredFields', 'optionalFields'] as const) {
      for (const [name, slot] of Object.entries(previous[id][key] ?? {})) {
        if (slot.status === 'filled' && next[id]?.[key]?.[name]?.status === 'empty') out.add(name);
      }
    }
  }
  return [...out];
}
