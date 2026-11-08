import { describe, expect, it } from 'vitest';
import { BRIEF_RECORD_MAPPINGS, briefOrigin, clearedFields, filledChanges, mappingFor, overlayRecords } from '../brief-records';
import { validateAttributes } from '../brand-catalog';
import type { AgentRequirementState, FieldSlot } from '../contracts';

const both = { hasBrand: true, hasProduct: true };
const brandOnly = { hasBrand: true, hasProduct: false };
const m = (name: string) => BRIEF_RECORD_MAPPINGS[name];
const state = (required: Record<string, FieldSlot>, optional: Record<string, FieldSlot> = {}): AgentRequirementState =>
  ({ requiredFields: required, optionalFields: optional, iterationCount: 0 });
const filled = (value: string): FieldSlot => ({ status: 'filled', value, confidence: 1 });

describe('brief-records mapping', () => {
  it('maps plain brand and product text fields both ways', () => {
    for (const [name, key, level] of [
      ['business_category', 'business_category', 'brand'], ['style_keywords', 'style_keywords', 'brand'],
      ['product_name', 'product_name', 'product'], ['product_composition', 'product_composition', 'product'],
      ['manufacturer', 'manufacturer', 'product'],
    ] as const) {
      expect(m(name).level).toBe(level);
      expect(m(name).toBrief({ brand: { [key]: ' x ' }, product: { [key]: ' x ' } })).toBe('x');
      expect(m(name).toBrief({ brand: {}, product: {} })).toBeUndefined();
      expect(m(name).fromBrief('v', {})).toEqual({ [key]: 'v' });
      expect(validateAttributes(level, m(name).fromBrief('v', {}), { partial: true }).ok).toBe(true);
    }
  });

  it('business_name clears name_pending on write and is empty while pending', () => {
    expect(m('business_name').fromBrief('Dulce', {})).toEqual({ business_name: 'Dulce', name_pending: false });
    const verdict = validateAttributes('brand', m('business_name').fromBrief('Dulce', {}), { partial: true });
    expect(verdict).toMatchObject({ ok: true, values: { business_name: 'Dulce' }, cleared: ['name_pending'] });
    expect(m('business_name').toBrief({ brand: { business_name: 'X', name_pending: true } })).toBeUndefined();
    expect(m('business_name').toBrief({ brand: { business_name: 'X' } })).toBe('X');
  });

  it('colors: hex list plus description, product override wins for reading, write goes to the description', () => {
    const brand = { color_palette: ['#AA0000', '#00FF00'], color_description: 'cálidos' };
    expect(m('color_palette').toBrief({ brand })).toBe('#AA0000, #00FF00, cálidos');
    expect(m('color_palette').toBrief({ brand: { color_palette: ['#AA0000'] } })).toBe('#AA0000');
    expect(m('color_palette').toBrief({ brand: { color_description: 'solo texto' } })).toBe('solo texto');
    expect(m('color_palette').toBrief({ brand: {} })).toBeUndefined();
    expect(m('color_palette').toBrief({ brand, product: { color_palette: ['#112233'] } })).toBe('#112233, cálidos');
    expect(m('color_palette').toBrief({ brand, product: { color_palette: [] } })).toBe('#AA0000, #00FF00, cálidos');
    expect(m('color_palette').level).toBe('brand');
    expect(m('color_palette').fromBrief('rojo y verde', brand)).toEqual({ color_description: 'rojo y verde' });
    expect(m('color_palette').fromBrief('#aa0000, #0b0, tonos cálidos', {})).toEqual({ color_palette: ['#AA0000', '#00BB00'], color_description: 'tonos cálidos' });
    expect(m('color_palette').fromBrief('#AA0000', {})).toEqual({ color_palette: ['#AA0000'], color_description: '' });
    expect(m('color_palette').fromBrief('rojo, #aa0000, verde', {})).toEqual({ color_palette: ['#AA0000'], color_description: 'rojo, verde' });
  });

  it.each([
    ['mixed', { color_palette: ['#AA0000', '#00BB00'], color_description: 'tonos cálidos' }],
    ['hex only', { color_palette: ['#AA0000'] }],
    ['text only', { color_description: 'tonos cálidos' }],
  ])('colors round trip is stable (%s)', (_n, brand) => {
    const map = m('color_palette');
    const shown = map.toBrief({ brand })!;
    const verdict = validateAttributes('brand', map.fromBrief(shown, brand), { partial: true });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const stored: Record<string, unknown> = { ...brand, ...verdict.values };
    for (const key of verdict.cleared) delete stored[key];
    expect(stored).toEqual(brand);
    expect(map.toBrief({ brand: stored })).toBe(shown);
  });

  it('presentation: reads the principal; an existing label becomes principal; a new one is added; at the cap it is ignored', () => {
    const items = [{ label: '250 g', principal: true }, { label: '500 g', principal: false }];
    const map = m('product_presentation');
    expect(map.toBrief({ brand: {}, product: { product_presentations: items } })).toBe('250 g');
    expect(map.toBrief({ brand: {}, product: {} })).toBeUndefined();
    expect(map.fromBrief('500 G', { product_presentations: items })).toEqual({
      product_presentations: [{ label: '250 g', principal: false }, { label: '500 g', principal: true }],
    });
    expect(map.fromBrief('1 kg', { product_presentations: items })).toEqual({
      product_presentations: [{ label: '250 g', principal: false }, { label: '500 g', principal: false }, { label: '1 kg', principal: true }],
    });
    expect(map.fromBrief('1 kg', {})).toEqual({ product_presentations: [{ label: '1 kg', principal: true }] });
    const full = ['a', 'b', 'c', 'd', 'e'].map((label, i) => ({ label, principal: i === 2 }));
    // At the cap a new label leaves the record untouched (no overwrite of the principal's label).
    expect(map.fromBrief('nueva', { product_presentations: full })).toEqual({});
    expect(map.fromBrief('C', { product_presentations: full })).toEqual({ product_presentations: full.map((p) => ({ ...p, principal: p.label === 'c' })) });
  });

  it('presentation: switching the principal via chat keeps exactly one principal and a valid payload', () => {
    const items = [{ label: '250 g', principal: true }, { label: '500 g', principal: false }];
    const out = m('product_presentation').fromBrief('500 g', { product_presentations: items });
    const verdict = validateAttributes('product', out, { partial: true });
    expect(verdict.ok && (verdict.values.product_presentations as { principal: boolean }[]).filter((p) => p.principal)).toHaveLength(1);
  });

  it('ignores unmapped fields and keeps product fields local in a brand conversation', () => {
    expect(mappingFor('product_description', both)).toBeUndefined();
    expect(mappingFor('regulatory_notes', both)).toBeUndefined();
    expect(mappingFor('toString', both)).toBeUndefined();
    expect(mappingFor('product_name', brandOnly)).toBeUndefined();
    expect(mappingFor('business_name', brandOnly)).toBeDefined();
    expect(mappingFor('business_name', { hasBrand: false, hasProduct: false })).toBeUndefined();
    expect(briefOrigin('business_name', both)).toBe('brand');
    expect(briefOrigin('product_name', both)).toBe('product');
    expect(briefOrigin('product_name', brandOnly)).toBe('conversation');
    expect(briefOrigin('product_description', both)).toBe('conversation');
  });
});

describe('overlayRecords', () => {
  const states = {
    logo: state(
      { business_name: { status: 'pending_confirmation', value: 'Viejo', confidence: 0.7 }, business_category: filled('Stored') },
      { style_keywords: { status: 'empty' }, product_description: filled('local') },
    ),
  };
  it('fills mapped slots from records (record wins), keeps slots without a record value and unmapped ones', () => {
    const out = overlayRecords(states, { brand: { business_name: 'Nuevo', style_keywords: 'rústico' } }, 'brief-panel');
    expect(out.logo.requiredFields.business_name).toMatchObject({ status: 'filled', value: 'Nuevo', source: 'brief-panel' });
    expect(out.logo.requiredFields.business_category).toEqual(filled('Stored'));
    expect(out.logo.optionalFields.style_keywords).toMatchObject({ status: 'filled', value: 'rústico' });
    expect(out.logo.optionalFields.product_description).toEqual(filled('local'));
  });
  it('does not overlay product fields without a product', () => {
    const s = { a: state({ product_name: { status: 'empty' } }) };
    expect(overlayRecords(s, { brand: {} }, 'x').a.requiredFields.product_name).toEqual({ status: 'empty' });
    expect(overlayRecords(s, { brand: {}, product: { product_name: 'Molido' } }, 'x').a.requiredFields.product_name).toMatchObject({ value: 'Molido' });
  });
});

describe('filledChanges / clearedFields', () => {
  it('reports only slots that became or changed to filled', () => {
    const prev = { a: state({ x: filled('1'), y: { status: 'pending_confirmation', value: 'p', confidence: 0.7 }, z: filled('keep') }) };
    const next = { a: state({ x: filled('2'), y: filled('p'), z: filled('keep'), w: { status: 'pending_confirmation', value: 'q', confidence: 0.7 } }) };
    expect([...filledChanges(prev, next)]).toEqual([['x', '2'], ['y', 'p']]);
  });
  it('lists filled slots that were emptied', () => {
    expect(clearedFields({ a: state({ x: filled('1') }) }, { a: state({ x: { status: 'empty' } }) })).toEqual(['x']);
  });
});
