import { describe, expect, it } from 'vitest';
import { BRIEF_CATALOG, isDeprecatedField, type BriefFieldSpec } from '../../brief';
import { factFor } from '../../brief-facts';
import { buildDefaultRegistry } from '../../orchestrator/bootstrap-registry';
import { canonicalize } from '../canonical';
import { DICTIONARIES, OTHER_CODE, dictionaryCodes, planPromotion, resolveCategory } from '..';

describe('catalog, cards and dictionaries stay consistent (D41)', () => {
  it('every enum field names a dictionary that ends with OTRO and has unique canonical codes', () => {
    const enums = BRIEF_CATALOG.filter((f) => f.type === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    for (const f of enums) {
      const dict = DICTIONARIES[f.vocabulary ?? ''];
      expect(dict, f.name).toBeDefined();
      const codes = dictionaryCodes(dict);
      expect(codes.at(-1)).toBe(OTHER_CODE);
      expect(new Set(codes).size).toBe(codes.length);
      expect(dict.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(dict.entries.every((e) => e.code === canonicalize(e.label))).toBe(true);
    }
  });

  it('every Agent Card field that is in the catalog agrees on type and vocabulary', () => {
    for (const entry of buildDefaultRegistry().list()) {
      const { required, optional } = entry.card['mypes:requirements'];
      for (const field of [...required, ...optional]) {
        const spec = BRIEF_CATALOG.find((f) => f.name === field.name);
        if (!spec) continue;
        expect(field.type, `${entry.card.name}.${field.name}`).toBe(spec.type);
        expect(field.vocabulary, `${entry.card.name}.${field.name}`).toBe(spec.vocabulary);
      }
    }
  });

  it('a deprecated field is excluded from the asked fields but keeps its catalog entry', () => {
    const catalog: BriefFieldSpec[] = [
      { name: 'old', type: 'string', analytics: 'text', label: 'Viejo', maxLength: 10, deprecatedSince: '2026-01-01' },
      { name: 'new', type: 'string', analytics: 'text', label: 'Nuevo', maxLength: 10 },
    ];
    expect(isDeprecatedField('old', catalog)).toBe(true);
    expect(isDeprecatedField('new', catalog)).toBe(false);
    const asked = new Set(buildDefaultRegistry().getFieldSchemas().flatMap((s) => [...s.requiredFields, ...s.optionalFields]));
    for (const f of BRIEF_CATALOG.filter((f) => f.deprecatedSince)) expect(asked.has(f.name)).toBe(false);
  });

  it('facts: enum maps to the code, unknown text to OTRO with the raw text kept, tags split, none skipped', () => {
    const spec = (name: string) => BRIEF_CATALOG.find((f) => f.name === name)!;
    expect(factFor(spec('business_category'), 'vendo pan', 'PANADERIA_Y_PASTELERIA')).toMatchObject({ canonicalValue: 'PANADERIA_Y_PASTELERIA', rawValue: 'vendo pan', dictionaryVersion: '2026-11-12' });
    expect(factFor(spec('business_category'), 'adiestramiento de loros', 'inventada')).toMatchObject({ canonicalValue: 'OTRO', rawValue: 'adiestramiento de loros', rawCanonical: 'ADIESTRAMIENTO_DE_LOROS' });
    expect(factFor(spec('business_category'), 'Artesanía')).toMatchObject({ canonicalValue: 'ARTESANIA' });
    expect(factFor(spec('style_keywords'), 'Moderno, cálido / Moderno')?.canonicalValue).toBe('MODERNO,CALIDO');
    expect(factFor(spec('business_name'), 'Dulce Andino')).toBeUndefined();
    expect(resolveCategory(DICTIONARIES.target_audience, 'x', undefined)).toBe('OTRO');
  });

  it('planPromotion canonicalizes and dedupes texts, and rejects a category not in the dictionary', () => {
    expect(planPromotion({ dictionaryKey: 'business_category', label: 'Tecnología', texts: ['Tecnologia', ' tecnología '] }).canonicalTexts).toEqual(['TECNOLOGIA']);
    expect(() => planPromotion({ dictionaryKey: 'business_category', label: 'Mascotas', texts: ['perros'] })).toThrow();
    expect(() => planPromotion({ dictionaryKey: 'business_category', label: 'Agro', texts: [] })).toThrow();
  });
});
