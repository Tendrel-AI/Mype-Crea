/**
 * D39 pure limit rules: effective limits + current use + an ask -> `null` (allowed) or a typed refusal.
 * No I/O, no catalog lookups. Also the ONE place with the client-facing refusal copy.
 *
 *  - The first generation of a deliverable is never blocked by an alteration limit.
 *  - A failed generation does not count (counters only count completed work; see `src/repos/limits.ts`).
 *  - A turn is a chat message that triggers the model.
 *  - Lowering a limit below current use only stops further use (`used >= limit` refuses; nothing is deleted).
 */
import { alterationKey, BRANDS_KEY, PRODUCTS_KEY, TURNS_KEY, type LimitValues } from './catalog';

export type LimitAsk =
  | { readonly kind: 'alteration'; readonly agentId: string; readonly deliverableLabel: string; readonly firstGeneration: boolean }
  | { readonly kind: 'turn' }
  | { readonly kind: 'brand' }
  | { readonly kind: 'product' };

export type LimitRefusalKind = 'alteration_limit_reached' | 'turn_limit_reached' | 'brand_limit_reached' | 'product_limit_reached';

export interface LimitRefusal {
  readonly kind: LimitRefusalKind;
  readonly key: string;
  readonly limit: number;
  readonly used: number;
  /** Deliverable name, only for alterations. */
  readonly deliverableLabel?: string;
}

const KEY_OF: Record<LimitAsk['kind'], (ask: LimitAsk) => string> = {
  alteration: (ask) => alterationKey((ask as Extract<LimitAsk, { kind: 'alteration' }>).agentId),
  turn: () => TURNS_KEY,
  brand: () => BRANDS_KEY,
  product: () => PRODUCTS_KEY,
};
const REFUSAL_OF: Record<LimitAsk['kind'], LimitRefusalKind> = {
  alteration: 'alteration_limit_reached',
  turn: 'turn_limit_reached',
  brand: 'brand_limit_reached',
  product: 'product_limit_reached',
};

export const limitKeyOf = (ask: LimitAsk): string => KEY_OF[ask.kind](ask);

/** `used` is how much of the limit is already consumed in the ask's scope. A missing limit fails closed (0). */
export function checkLimit(limits: LimitValues, ask: LimitAsk, used: number): LimitRefusal | null {
  if (ask.kind === 'alteration' && ask.firstGeneration) return null;
  const key = limitKeyOf(ask);
  const limit = limits[key] ?? 0;
  if (used < limit) return null;
  return {
    kind: REFUSAL_OF[ask.kind], key, limit, used,
    ...(ask.kind === 'alteration' ? { deliverableLabel: ask.deliverableLabel } : {}),
  };
}

export const remaining = (limit: number, used: number): number => Math.max(0, limit - used);

/** Client-facing copy: neutral Latin-American Spanish, tuteo. The only place these messages live. */
export function refusalMessage(refusal: Pick<LimitRefusal, 'kind' | 'limit' | 'deliverableLabel'>): string {
  switch (refusal.kind) {
    case 'alteration_limit_reached':
      return `Ya usaste los ${refusal.limit} retoques disponibles de ${refusal.deliverableLabel ?? 'este entregable'}. Pide a tu administrador que aumente el límite.`;
    case 'turn_limit_reached':
      return `Llegaste al límite de ${refusal.limit} mensajes de esta conversación. Pide a tu administrador que aumente el límite.`;
    case 'brand_limit_reached':
      return `Llegaste al límite de ${refusal.limit} marcas de tu organización. Archiva una marca o pide a tu administrador que lo aumente.`;
    case 'product_limit_reached':
      return `Esta marca llegó al límite de ${refusal.limit} productos. Pide a tu administrador que lo aumente.`;
  }
}
