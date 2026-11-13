import { describe, expect, it } from 'vitest';
import { buildLimitCatalog } from '../catalog';
import { createLimitGate, type LimitsPort } from '../gate';
import { checkLimit, refusalMessage, type LimitAsk } from '../rules';

const LIMITS = { 'alterations.logo-agent': 3, 'turns.per_conversation': 40, 'brands.per_user': 3, 'products.per_brand': 5 };
const alteration = (firstGeneration: boolean): LimitAsk => ({ kind: 'alteration', agentId: 'logo-agent', deliverableLabel: 'Logo', firstGeneration });

describe('checkLimit (D39)', () => {
  it.each<[string, LimitAsk, number, string | null]>([
    ['alteration under the limit', alteration(false), 2, null],
    ['alteration at the limit', alteration(false), 3, 'alteration_limit_reached'],
    ['alteration over the limit (limit lowered below use)', alteration(false), 7, 'alteration_limit_reached'],
    ['first generation is never blocked', alteration(true), 99, null],
    ['turn under the limit', { kind: 'turn' }, 39, null],
    ['turn at the limit', { kind: 'turn' }, 40, 'turn_limit_reached'],
    ['brand at the limit', { kind: 'brand' }, 3, 'brand_limit_reached'],
    ['product under the limit', { kind: 'product' }, 4, null],
    ['product at the limit', { kind: 'product' }, 5, 'product_limit_reached'],
  ])('%s', (_name, ask, used, kind) => {
    expect(checkLimit(LIMITS, ask, used)?.kind ?? null).toBe(kind);
  });

  it('a limit of 0 refuses; a missing key fails closed', () => {
    expect(checkLimit({ 'brands.per_user': 0 }, { kind: 'brand' }, 0)?.limit).toBe(0);
    expect(checkLimit({}, { kind: 'turn' }, 0)?.kind).toBe('turn_limit_reached');
  });

  it('refusal copy is neutral Spanish with tuteo (no voseo)', () => {
    const texts = [
      refusalMessage({ kind: 'alteration_limit_reached', limit: 3, deliverableLabel: 'Logo' }),
      refusalMessage({ kind: 'turn_limit_reached', limit: 40 }),
      refusalMessage({ kind: 'brand_limit_reached', limit: 3 }),
      refusalMessage({ kind: 'product_limit_reached', limit: 5 }),
    ];
    texts.forEach((text) => expect(text).not.toMatch(/\b(tenés|podés|querés|vos|sos|acá)\b/i));
    expect(texts[0]).toContain('Logo');
  });
});

describe('createLimitGate', () => {
  const catalog = buildLimitCatalog([
    { name: 'logo-agent', 'mypes:ui': { tabLabel: 'Logo' }, 'mypes:deliverable': { kind: 'logo', dependsOn: [], level: 'brand' } } as never,
  ]);
  const port = (usage: { used: number; hasResult: boolean }, turns = 0, stored = {}): LimitsPort => ({
    effectiveLimits: async () => stored,
    alterationUsage: async () => usage,
    turnsUsed: async () => turns,
  });
  const conv = 'c' as never;

  it('blocks an alteration at the limit but not the first generation', async () => {
    expect(await createLimitGate(port({ used: 3, hasResult: true }), catalog).checkAlteration(conv, 'logo-agent'))
      .toMatchObject({ kind: 'alteration_limit_reached', limit: 3, used: 3 });
    const zero = createLimitGate(port({ used: 0, hasResult: false }, 0, { 'alterations.logo-agent': 0 }), catalog);
    expect(await zero.checkAlteration(conv, 'logo-agent')).toBeNull();
  });

  it('uses the profile value over the catalog default and ignores unknown agents', async () => {
    const gate = createLimitGate(port({ used: 3, hasResult: true }, 0, { 'alterations.logo-agent': 5 }), catalog);
    expect(await gate.checkAlteration(conv, 'logo-agent')).toBeNull();
    expect(await gate.checkAlteration(conv, 'other-agent')).toBeNull();
  });

  it('blocks a turn at the limit and reports remaining counts', async () => {
    const gate = createLimitGate(port({ used: 1, hasResult: true }, 40), catalog);
    expect(await gate.checkTurn(conv)).toMatchObject({ kind: 'turn_limit_reached' });
    expect(await gate.remaining(conv)).toEqual({
      turns: { limit: 40, used: 40, remaining: 0 },
      alterations: { 'logo-agent': { limit: 3, used: 1, remaining: 2 } },
    });
  });
});
