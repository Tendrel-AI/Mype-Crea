/**
 * D38 limit-key catalog: the ONE definition of which limits exist.
 * Fixed keys plus one `alterations.<agentId>` per live Agent Card (derived, never hand-listed).
 * The DB stores only values (`limit_profile_values`, `platform_limit_defaults`); the shape of a key is
 * validated there by regex, its meaning (label, default, counting scope) lives here.
 */
import type { AgentCard } from '../orchestrator/agent-registry';

/** What a counter is grouped by: a brand, a product, a conversation, or the user. */
export type LimitScope = 'brand' | 'product' | 'conversation' | 'user';
export type LimitGroup = 'alterations' | 'turns' | 'brands' | 'products';

export interface LimitKeyDef {
  readonly key: string;
  readonly group: LimitGroup;
  /** Spanish, shown to the tenant admin. */
  readonly label: string;
  readonly default: number;
  readonly scope: LimitScope;
  /** Only for `alterations.*` keys. */
  readonly agentId?: string;
  /** Only for `alterations.*` keys: the deliverable's Spanish name (card tab label), used in user-facing copy. */
  readonly deliverableLabel?: string;
}

export type LimitCatalog = ReadonlyArray<LimitKeyDef>;
/** key -> value, always complete for a catalog once `withDefaults` is applied. */
export type LimitValues = Readonly<Record<string, number>>;

export const TURNS_KEY = 'turns.per_conversation';
export const BRANDS_KEY = 'brands.per_user';
export const PRODUCTS_KEY = 'products.per_brand';
export const alterationKey = (agentId: string): string => `alterations.${agentId}`;

/** Bounds enforced by the DB function and the admin action alike. */
export const LIMIT_MIN = 0;
export const LIMIT_MAX = 1000;
export const isValidLimitValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX;

const FIXED: LimitCatalog = [
  { key: TURNS_KEY, group: 'turns', label: 'Mensajes por conversación', default: 40, scope: 'conversation' },
  { key: BRANDS_KEY, group: 'brands', label: 'Marcas por usuario', default: 3, scope: 'user' },
  { key: PRODUCTS_KEY, group: 'products', label: 'Productos por marca', default: 5, scope: 'brand' },
];

export const DEFAULT_ALTERATIONS = 3;

/** Fixed keys only; enough for the count limits checked inside the brand/product transactions. */
export const FIXED_CATALOG: LimitCatalog = FIXED;

/**
 * Catalog for a set of cards. The counting scope of an alteration key follows the card's declared
 * deliverable `level` (default `product`, like the registry).
 */
export function buildLimitCatalog(cards: ReadonlyArray<Pick<AgentCard, 'name' | 'mypes:ui' | 'mypes:deliverable'>>): LimitCatalog {
  const alterations: LimitKeyDef[] = cards
    .map((card) => {
      const label = card['mypes:ui']?.tabLabel ?? card.name;
      return {
        key: alterationKey(card.name),
        group: 'alterations' as const,
        label: `Retoques de ${label}`,
        default: DEFAULT_ALTERATIONS,
        scope: card['mypes:deliverable']?.level === 'brand' ? ('brand' as const) : ('product' as const),
        agentId: card.name,
        deliverableLabel: label,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return [...alterations, ...FIXED];
}

export const catalogDefaults = (catalog: LimitCatalog): Record<string, number> =>
  Object.fromEntries(catalog.map((def) => [def.key, def.default]));

/** Stored values (profile over platform defaults) completed with the catalog's code defaults. */
export const withDefaults = (catalog: LimitCatalog, stored: LimitValues): LimitValues => ({
  ...catalogDefaults(catalog),
  ...Object.fromEntries(Object.entries(stored).filter(([key]) => catalog.some((def) => def.key === key))),
});
