/**
 * KAN-87 brand and product attribute catalog.
 *
 * The ONE definition of the typed attributes stored in `brands.attributes` / `products.attributes`:
 * key, level, Spanish label, kind, limits. The forms render from it and the server validates with it
 * (`validateAttributes`), so client and server share the same rule. Names that match a brief field
 * (`business_name`, `business_category`, `color_palette`, `product_name`) keep the brief's meaning so
 * a later phase can map them 1:1. Single-line text reuses `validateBriefValue`; longtext keeps its line breaks.
 *
 * Pure: no I/O. Importable by client and server.
 */
import { validateBriefValue } from './brief';

export type AttributeLevel = 'brand' | 'product';
export type FieldKind = 'text' | 'longtext' | 'choice' | 'multichoice' | 'colors' | 'money' | 'presentations';

export interface CatalogField {
  readonly key: string;
  readonly level: AttributeLevel;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  /** Text and longtext only (code points). */
  readonly maxLength?: number;
  /** Choice and multichoice only. */
  readonly options?: ReadonlyArray<string>;
  /** Product field that inherits the brand's value when left empty. */
  readonly overridesBrand?: boolean;
}

export interface Presentation {
  readonly label: string;
  readonly principal: boolean;
}

export const MAX_COLORS = 5;
export const MAX_PRESENTATIONS = 5;
export const MAX_PRESENTATION_LABEL = 60;
export const MAX_PRICE_PEN = 100000;
/** Asset files per brand, and per product. */
export const MAX_BRAND_ASSETS = 5;
export const MAX_ATTRIBUTES_BYTES = 16 * 1024;
/** Brand-level flag: the owner has no business name yet («Aún no tengo nombre»). */
export const NAME_PENDING_KEY = 'name_pending';
/** Brand-level flag set by the server for «Ya tengo una marca»; never accepted from a client. */
export const IMPORTED_KEY = 'imported';
const FORM_KEY = '_form';

const brand = (key: string, label: string, kind: FieldKind, extra: Partial<CatalogField> = {}): CatalogField =>
  ({ key, level: 'brand', label, kind, ...extra });
const product = (key: string, label: string, kind: FieldKind, extra: Partial<CatalogField> = {}): CatalogField =>
  ({ key, level: 'product', label, kind, ...extra });

export const CHANNEL_OPTIONS = ['Bodega', 'Mercado', 'Feria', 'Supermercado', 'Tienda propia', 'Redes sociales', 'Delivery', 'Otro'] as const;
export const PACKAGE_OPTIONS = ['Bolsa', 'Frasco', 'Botella', 'Caja', 'Lata', 'Sachet', 'Otro'] as const;
export const MOMENT_OPTIONS = ['Desayuno', 'Media mañana', 'Almuerzo', 'Lonche', 'Cena', 'Snack', 'Ocasiones especiales'] as const;
export const OCTAGON_OPTIONS = ['Alto en azúcar', 'Alto en sodio', 'Alto en grasas saturadas', 'Contiene grasas trans'] as const;

export const BRAND_CATALOG: ReadonlyArray<CatalogField> = Object.freeze([
  brand('business_name', 'Nombre del negocio', 'text', { required: true, maxLength: 120 }),
  brand('business_category', 'Rubro', 'text', { required: true, maxLength: 120 }),
  brand('market_proposition', 'Propuesta de mercado', 'longtext', { required: true, maxLength: 500 }),
  brand('target_audience', 'Público objetivo', 'longtext', { required: true, maxLength: 500 }),
  brand('differentiator', 'Diferencial', 'longtext', { maxLength: 500 }),
  brand('personality', 'Personalidad y percepción', 'longtext', { maxLength: 500 }),
  brand('language_references', 'Idioma y referencias culturales/artísticas', 'longtext', { maxLength: 500 }),
  brand('mission_vision', 'Misión y visión', 'longtext', { maxLength: 1000 }),
  brand('brand_story', 'Historia detrás de la marca', 'longtext', { maxLength: 1000 }),
  brand('visual_behavior', 'Comportamiento visual deseado', 'longtext', { maxLength: 500 }),
  brand('color_palette', 'Colores', 'colors'),
  brand('location', 'Ubicación', 'text', { maxLength: 120 }),
  brand('sales_channels', 'Canales de venta', 'multichoice', { options: CHANNEL_OPTIONS }),
  brand('existing_tagline', 'Lema actual', 'text', { maxLength: 120 }),
  brand('social_accounts', 'Redes sociales actuales', 'text', { maxLength: 300 }),
]);

export const PRODUCT_CATALOG: ReadonlyArray<CatalogField> = Object.freeze([
  product('product_name', 'Nombre del producto', 'text', { required: true, maxLength: 120 }),
  product('food_denomination', 'Denominación de alimento', 'text', { required: true, maxLength: 160 }),
  product('package_type', 'Tipo de envase', 'choice', { required: true, options: PACKAGE_OPTIONS }),
  product('product_presentations', 'Presentaciones', 'presentations', { required: true }),
  product('price_pen', 'Precio (S/)', 'money'),
  product('consumption_moments', 'Momento de consumo', 'multichoice', { options: MOMENT_OPTIONS }),
  product('sanitary_registration', 'Registro sanitario', 'text', { maxLength: 60 }),
  product('warning_octagons', 'Octógonos', 'multichoice', { options: OCTAGON_OPTIONS }),
  product('differentiator', 'Diferencial', 'longtext', { maxLength: 500, overridesBrand: true }),
  product('target_audience', 'Público objetivo', 'longtext', { maxLength: 500, overridesBrand: true }),
  product('personality', 'Personalidad y percepción', 'longtext', { maxLength: 500, overridesBrand: true }),
  product('color_palette', 'Colores', 'colors', { overridesBrand: true }),
]);

export const catalogFor = (level: AttributeLevel): ReadonlyArray<CatalogField> =>
  level === 'brand' ? BRAND_CATALOG : PRODUCT_CATALOG;

export type AttributesResult =
  | { readonly ok: true; readonly values: Record<string, unknown>; readonly cleared: ReadonlyArray<string> }
  | { readonly ok: false; readonly errors: Record<string, string> };

type FieldOutcome = { readonly empty: true } | { readonly value: unknown } | { readonly error: string };

const isBlank = (raw: unknown) =>
  raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const has = (input: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(input, key);

/**
 * Longtext keeps its line breaks: runs of spaces and tabs inside a line become one space, every line is
 * trimmed, 3+ consecutive newlines become one blank line, and the length counts code points.
 */
function longtext(field: CatalogField, raw: unknown): FieldOutcome {
  if (typeof raw !== 'string') return { error: 'No pudimos validar este dato.' };
  if (/[^\P{Cc}\t\n\r]/u.test(raw)) return { error: `«${field.label}» tiene caracteres no permitidos.` };
  const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (value.length === 0) return { error: `Escribe un valor para «${field.label}».` };
  if ([...value].length > (field.maxLength ?? 500)) return { error: `«${field.label}» puede tener hasta ${field.maxLength} caracteres.` };
  return { value };
}

function text(field: CatalogField, raw: unknown): FieldOutcome {
  const result = validateBriefValue({ name: field.key, type: 'string', label: field.label, maxLength: field.maxLength ?? 120 }, raw);
  return result.ok ? { value: result.value } : { error: result.message };
}

function choose(field: CatalogField, raw: unknown, many: boolean): FieldOutcome {
  const picked = many ? raw : [raw];
  if (!Array.isArray(picked) || picked.some((item) => typeof item !== 'string' || !field.options?.includes(item))
    || new Set(picked).size !== picked.length) {
    return { error: `Elige opciones válidas para «${field.label}».` };
  }
  return { value: many ? picked : picked[0] };
}

function colors(field: CatalogField, raw: unknown): FieldOutcome {
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c))) {
    return { error: `Cada color de «${field.label}» debe ser un código #RRGGBB.` };
  }
  const normalized = raw.map((c) => c.toUpperCase());
  if (new Set(normalized).size !== normalized.length) return { error: 'No repitas colores.' };
  if (normalized.length > MAX_COLORS) return { error: `Puedes elegir hasta ${MAX_COLORS} colores.` };
  return { value: normalized };
}

/** Number with at most 2 decimals (PEN), 0..MAX_PRICE_PEN, kept as a number. */
function money(field: CatalogField, raw: unknown): FieldOutcome {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { error: `Ingresa un monto válido para «${field.label}».` };
  if (raw < 0 || raw > MAX_PRICE_PEN) return { error: `«${field.label}» debe estar entre 0 y ${MAX_PRICE_PEN}.` };
  const cents = Math.round(raw * 100);
  if (Math.abs(raw * 100 - cents) > 1e-6) return { error: `«${field.label}» admite hasta 2 decimales.` };
  return { value: cents / 100 };
}

function presentations(field: CatalogField, raw: unknown): FieldOutcome {
  if (!Array.isArray(raw)) return { error: `Agrega al menos una presentación.` };
  if (raw.length > MAX_PRESENTATIONS) return { error: `Puedes agregar hasta ${MAX_PRESENTATIONS} presentaciones.` };
  const items: Presentation[] = [];
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.principal !== 'boolean') return { error: `Revisa las presentaciones.` };
    const label = validateBriefValue({ name: field.key, type: 'string', label: 'Presentación', maxLength: MAX_PRESENTATION_LABEL }, item.label);
    if (!label.ok) return { error: label.message };
    items.push({ label: label.value, principal: item.principal });
  }
  if (items.filter((i) => i.principal).length !== 1) return { error: 'Marca exactamente una presentación como principal.' };
  if (new Set(items.map((i) => i.label.toLowerCase())).size !== items.length) return { error: 'No repitas presentaciones.' };
  return { value: items };
}

function normalize(field: CatalogField, raw: unknown): FieldOutcome {
  switch (field.kind) {
    case 'text': return text(field, raw);
    case 'longtext': return longtext(field, raw);
    case 'choice': return choose(field, raw, false);
    case 'multichoice': return choose(field, raw, true);
    case 'colors': return colors(field, raw);
    case 'money': return money(field, raw);
    case 'presentations': return presentations(field, raw);
  }
}

/**
 * Validate and normalize attributes. Unknown keys are rejected. Empty optional values are reported in
 * `cleared` (not stored). `partial` skips the required check for keys the input does not mention
 * (a patch); a mentioned required key can never be emptied, and the caller validates the merged
 * object again with `partial: false`. Messages are neutral Spanish (tú).
 */
export function validateAttributes(
  level: AttributeLevel,
  input: unknown,
  options: { readonly partial?: boolean } = {},
): AttributesResult {
  if (!isPlainObject(input)) return { ok: false, errors: { [FORM_KEY]: 'Revisa los datos e inténtalo de nuevo.' } };
  const fields = catalogFor(level);
  const errors: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const cleared: string[] = [];
  const meta = level === 'brand' ? [NAME_PENDING_KEY, IMPORTED_KEY] : [];
  for (const key of Object.keys(input)) {
    if (!fields.some((f) => f.key === key) && !meta.includes(key)) errors[key] = 'Este campo no está permitido.';
  }
  for (const key of meta) {
    if (!has(input, key)) continue;
    if (typeof input[key] !== 'boolean') errors[key] = 'Valor no válido.';
    else if (input[key]) values[key] = true;
    else cleared.push(key);
  }
  const pending = level === 'brand' && values[NAME_PENDING_KEY] === true;
  for (const field of fields) {
    const present = has(input, field.key);
    if (!present && options.partial) continue;
    const raw = present ? input[field.key] : undefined;
    // A pending name means «no business name yet»: whatever was typed is dropped.
    if (field.key === 'business_name' && pending) { if (present) cleared.push(field.key); continue; }
    if (isBlank(raw)) {
      if (field.required) errors[field.key] = `Completa «${field.label}».`;
      else if (present) cleared.push(field.key);
      continue;
    }
    const outcome = normalize(field, raw);
    if ('error' in outcome) errors[field.key] = outcome.error;
    else if ('value' in outcome) values[field.key] = outcome.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (byteLength(values) > MAX_ATTRIBUTES_BYTES) {
    return { ok: false, errors: { [FORM_KEY]: 'Los datos son demasiado largos. Acórtalos e inténtalo de nuevo.' } };
  }
  return { ok: true, values, cleared };
}

function byteLength(values: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(values)).length;
}

/** Apply a validated patch to the stored attributes. */
export function applyAttributePatch(
  existing: Record<string, unknown>,
  patch: { readonly values: Record<string, unknown>; readonly cleared: ReadonlyArray<string> },
): Record<string, unknown> {
  const merged = { ...existing, ...patch.values };
  for (const key of patch.cleared) delete merged[key];
  return merged;
}

/** The entity name stored in `brands.name` / `products.name`: `business_name` / `product_name`, else null. */
export function entityName(level: AttributeLevel, attributes: Record<string, unknown>): string | null {
  const value = attributes[level === 'brand' ? 'business_name' : 'product_name'];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Short text for the «Heredado de la marca: …» hint. */
export function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : (v as Presentation).label)).join(', ');
  return value === undefined || value === null ? '' : String(value);
}
