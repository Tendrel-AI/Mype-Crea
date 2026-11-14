import { describe, expect, it } from 'vitest';
import { applyAttributePatch, validateAttributes } from '../brand-catalog';

const brand = { business_name: 'Café Andino', business_category: 'Café', market_proposition: 'Café de altura', target_audience: 'Jóvenes' };
const product = {
  product_name: 'Café molido', food_denomination: 'Café tostado y molido', package_type: 'Bolsa',
  product_presentations: [{ label: '250 g', principal: true }],
};
const errorsOf = (level: 'brand' | 'product', input: unknown, partial = false) => {
  const result = validateAttributes(level, input, { partial });
  return result.ok ? null : result.errors;
};

describe('validateAttributes: brand', () => {
  it('accepts the required fields and normalizes text', () => {
    const result = validateAttributes('brand', { ...brand, business_name: '  Café   Andino ' });
    expect(result).toMatchObject({ ok: true, values: { business_name: 'Café Andino' } });
  });

  it('requires business_name, rubro, propuesta and público', () => {
    expect(Object.keys(errorsOf('brand', {})!).sort()).toEqual(['business_category', 'business_name', 'market_proposition', 'target_audience']);
  });

  it('name_pending replaces the business name requirement and drops a typed name', () => {
    const { business_name: _n, ...rest } = brand;
    expect(validateAttributes('brand', { ...rest, name_pending: true })).toMatchObject({ ok: true, values: { name_pending: true } });
    const typed = validateAttributes('brand', { ...brand, name_pending: true });
    expect(typed).toMatchObject({ ok: true, cleared: ['business_name'] });
    expect(typed.ok && typed.values.business_name).toBeUndefined();
    expect(errorsOf('brand', { ...rest, name_pending: false })).toHaveProperty('business_name');
  });

  it('rejects unknown keys instead of storing them', () => {
    expect(errorsOf('brand', { ...brand, evil: 'x' })).toHaveProperty('evil');
    expect(errorsOf('brand', { ...brand, product_name: 'x' })).toHaveProperty('product_name');
    expect(errorsOf('brand', 'nope')).toHaveProperty('_form');
    expect(errorsOf('brand', ['x'])).toHaveProperty('_form');
  });

  it('colors: uppercases, rejects duplicates, bad hex and more than 5', () => {
    expect(validateAttributes('brand', { ...brand, color_palette: ['#ff0000', '#00ff00'] })).toMatchObject({ ok: true, values: { color_palette: ['#FF0000', '#00FF00'] } });
    expect(errorsOf('brand', { ...brand, color_palette: ['#ff0000', '#FF0000'] })).toHaveProperty('color_palette');
    expect(errorsOf('brand', { ...brand, color_palette: ['red'] })).toHaveProperty('color_palette');
    expect(errorsOf('brand', { ...brand, color_palette: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'] })).toHaveProperty('color_palette');
  });

  it('multichoice: only listed options, no repeats; empty means not answered', () => {
    expect(validateAttributes('brand', { ...brand, sales_channels: ['Feria', 'Delivery'] })).toMatchObject({ ok: true, values: { sales_channels: ['Feria', 'Delivery'] } });
    expect(errorsOf('brand', { ...brand, sales_channels: ['Teletransporte'] })).toHaveProperty('sales_channels');
    expect(errorsOf('brand', { ...brand, sales_channels: ['Feria', 'Feria'] })).toHaveProperty('sales_channels');
    expect(validateAttributes('brand', { ...brand, sales_channels: [] })).toMatchObject({ ok: true, cleared: ['sales_channels'] });
  });

  it('enforces text lengths and rejects control characters', () => {
    expect(errorsOf('brand', { ...brand, business_name: 'x'.repeat(121) })).toHaveProperty('business_name');
    expect(errorsOf('brand', { ...brand, market_proposition: 'x'.repeat(501) })).toHaveProperty('market_proposition');
    expect(errorsOf('brand', { ...brand, business_name: 'a\u0000b' })).toHaveProperty('business_name');
  });

  it('caps the serialized attributes at 16 KB (4-byte characters fill every field to its limit)', () => {
    const full = (n: number) => '\u{1F600}'.repeat(n);
    const everything = {
      business_name: full(120), business_category: full(120), market_proposition: full(500), target_audience: full(500),
      differentiator: full(500), personality: full(500), language_references: full(500), mission_vision: full(1000),
      brand_story: full(1000), visual_behavior: full(500), location: full(120), existing_tagline: full(120), social_accounts: full(300),
    };
    expect(errorsOf('brand', everything)).toHaveProperty('_form');
    const { brand_story: _s, mission_vision: _m, ...smaller } = everything;
    expect(validateAttributes('brand', smaller).ok).toBe(true);
  });
});

describe('longtext line breaks', () => {
  const story = (value: string) => validateAttributes('brand', { ...brand, brand_story: value });
  it('keeps newlines, trims each line, collapses spaces/tabs and 3+ blank lines', () => {
    expect(story('  Línea   uno \t\n  Línea dos  \r\n\n\n\n\nTercera ')).toMatchObject({ ok: true, values: { brand_story: 'Línea uno\nLínea dos\n\nTercera' } });
  });
  it('counts code points, not UTF-16 units, and still rejects control characters', () => {
    expect(story('\u{1F600}'.repeat(1000)).ok).toBe(true);
    expect(story('\u{1F600}'.repeat(1001)).ok).toBe(false);
    expect(story('a\u0000b').ok).toBe(false);
  });
  it('single-line text still collapses newlines into one space', () => {
    expect(validateAttributes('brand', { ...brand, business_name: 'Café\n  Andino' })).toMatchObject({ ok: true, values: { business_name: 'Café Andino' } });
  });
  it('a longtext of only whitespace is empty (required ones fail)', () => {
    expect(errorsOf('brand', { ...brand, market_proposition: ' \n\t ' })).toHaveProperty('market_proposition');
  });
});

describe('validateAttributes: product', () => {
  it('accepts the required fields', () => {
    expect(validateAttributes('product', product)).toMatchObject({ ok: true });
  });

  it('requires name, denominación, envase and presentaciones', () => {
    expect(Object.keys(errorsOf('product', {})!).sort()).toEqual(['food_denomination', 'package_type', 'product_name', 'product_presentations']);
  });

  it.each([
    ['no principal: the first becomes principal', [{ label: 'A', principal: false }, { label: 'B', principal: false }], [true, false]],
    ['two principals: the first flagged one wins', [{ label: 'A', principal: false }, { label: 'B', principal: true }, { label: 'C', principal: true }], [false, true, false]],
    ['one presentation is principal even if unflagged', [{ label: 'A', principal: false }], [true]],
    ['switching the principal', [{ label: 'A', principal: false }, { label: 'B', principal: true }], [false, true]],
  ])('presentations normalize to exactly one principal: %s', (_label, presentations, expected) => {
    const verdict = validateAttributes('product', { ...product, product_presentations: presentations });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect((verdict.values.product_presentations as { principal: boolean }[]).map((p) => p.principal)).toEqual(expected);
  });

  it('removing the principal row (first remaining is promoted) validates', () => {
    const rest = [{ label: 'B', principal: false }, { label: 'C', principal: false }];
    const verdict = validateAttributes('product', { ...product, product_presentations: rest });
    expect(verdict.ok && (verdict.values.product_presentations as { principal: boolean }[])[0].principal).toBe(true);
  });

  it.each([
    ['zero presentations', []],
    ['six presentations', Array.from({ length: 6 }, (_, i) => ({ label: `P${i}`, principal: i === 0 }))],
    ['duplicate labels (case-insensitive)', [{ label: 'Bolsa', principal: true }, { label: 'bolsa', principal: false }]],
    ['label over 60', [{ label: 'x'.repeat(61), principal: true }]],
  ])('presentations: %s is refused', (_label, presentations) => {
    expect(errorsOf('product', { ...product, product_presentations: presentations })).toHaveProperty('product_presentations');
  });

  it.each([
    ['negative', -1], ['three decimals', 1.234], ['over 100000', 100000.01], ['text', '5' as never], ['NaN', Number.NaN],
  ])('money: %s is refused', (_label, price) => {
    expect(errorsOf('product', { ...product, price_pen: price })).toHaveProperty('price_pen');
  });

  it('money: accepts 0, 2 decimals and the maximum', () => {
    for (const price of [0, 12.5, 0.1 + 0.2 - 0.2, 100000]) {
      expect(validateAttributes('product', { ...product, price_pen: price }).ok).toBe(true);
    }
  });

  it('choice: package_type must be an option', () => {
    expect(errorsOf('product', { ...product, package_type: 'Cohete' })).toHaveProperty('package_type');
  });

  it('overrides are optional and empty means inherited', () => {
    expect(validateAttributes('product', { ...product, differentiator: '', color_palette: [] })).toMatchObject({ ok: true, cleared: ['differentiator', 'color_palette'] });
  });
});

describe('partial edits', () => {
  it('skips required checks for keys the patch does not mention', () => {
    expect(validateAttributes('brand', { location: 'Lima' }, { partial: true })).toMatchObject({ ok: true, values: { location: 'Lima' } });
  });

  it('keeps required fields required: a mentioned required key cannot be emptied', () => {
    expect(errorsOf('brand', { business_category: '  ' }, true)).toHaveProperty('business_category');
    expect(errorsOf('product', { product_presentations: [] }, true)).toHaveProperty('product_presentations');
  });

  it('the merged object is validated again: clearing a required value through the patch fails', () => {
    const patch = validateAttributes('brand', { name_pending: false }, { partial: true });
    expect(patch).toMatchObject({ ok: true, cleared: ['name_pending'] });
    const { business_name: _n, ...withoutName } = brand;
    const merged = applyAttributePatch(withoutName, patch as never);
    expect(validateAttributes('brand', merged, { partial: false }).ok).toBe(false);
  });
});
