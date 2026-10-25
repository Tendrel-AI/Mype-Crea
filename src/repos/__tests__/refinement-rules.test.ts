import { describe, expect, it } from 'vitest';
import {
  REFINEMENT_LIMITS,
  checkStoredRefinement,
  codePointLength,
  validateRefinement,
} from '../refinement-rules';
import { REFINEMENT_PARITY_CASES } from './fixtures/refinement-parity-cases';

const VOSEO = /\b(pod[eé]s|ten[eé]s|quer[eé]s|escrib[ií]|eleg[ií]|sos|vos)\b/i;

describe('checkStoredRefinement (parity cases shared with app.is_valid_refinement)', () => {
  it.each(REFINEMENT_PARITY_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(checkStoredRefinement(c.value).ok).toBe(c.valid);
  });
});

describe('validateRefinement', () => {
  it('defaults collections, trims observations and lowercases the anchor', () => {
    const result = validateRefinement({
      observations: ['  Hazlo más azul \n'],
      anchorDeliverableId: '3F1C2A4E-9B7D-4C2E-8F10-0A1B2C3D4E5F',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        parameterChanges: {},
        observations: ['Hazlo más azul'],
        anchorDeliverableId: '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f',
      },
    });
  });

  it('accepts exactly the caps and rejects one past each cap', () => {
    const max = REFINEMENT_LIMITS;
    expect(validateRefinement({ observations: Array(max.maxObservations).fill('ok') }).ok).toBe(true);
    expect(validateRefinement({ observations: Array(max.maxObservations + 1).fill('ok') })).toMatchObject({
      ok: false,
      code: 'too_many_observations',
    });
    expect(validateRefinement({ observations: ['a'.repeat(max.maxObservationChars)] }).ok).toBe(true);
    expect(validateRefinement({ observations: ['a'.repeat(max.maxObservationChars + 1)] })).toMatchObject({
      ok: false,
      code: 'observation_too_long',
    });
  });

  it('measures length after trimming (what is stored is what is compared)', () => {
    const padded = `   ${'a'.repeat(REFINEMENT_LIMITS.maxObservationChars)}   `;
    expect(validateRefinement({ observations: [padded] }).ok).toBe(true);
  });

  it('rejects observations that are empty after trimming, including unicode spaces', () => {
    expect(validateRefinement({ observations: ['   '] })).toMatchObject({ code: 'empty_observation' });
    expect(validateRefinement({ observations: ['  '] })).toMatchObject({ code: 'empty_observation' });
  });

  it('rejects NUL characters, which PostgreSQL cannot store', () => {
    expect(validateRefinement({ observations: ['a\u0000b'] })).toMatchObject({ code: 'invalid_observation' });
    expect(validateRefinement({ parameterChanges: { c: 'a\u0000' } })).toMatchObject({
      code: 'invalid_parameter_value',
    });
  });

  it('rejects non-finite numbers and non-primitive parameter values', () => {
    expect(validateRefinement({ parameterChanges: { size: Number.NaN } })).toMatchObject({
      code: 'invalid_parameter_value',
    });
    expect(validateRefinement({ parameterChanges: { size: Infinity } })).toMatchObject({
      code: 'invalid_parameter_value',
    });
    expect(validateRefinement({ parameterChanges: { color: undefined } })).toMatchObject({
      code: 'invalid_parameter_value',
    });
  });

  it('rejects unknown keys such as the legacy freeTextHint and non-object input', () => {
    expect(validateRefinement({ freeTextHint: 'más azul' })).toMatchObject({ code: 'invalid_shape' });
    expect(validateRefinement(null)).toMatchObject({ code: 'invalid_shape' });
    expect(validateRefinement({ observations: 'más azul' })).toMatchObject({ code: 'invalid_shape' });
  });

  it('returns neutral Spanish messages with tú and no voseo', () => {
    const failures = [
      validateRefinement({ observations: Array(6).fill('a') }),
      validateRefinement({ observations: ['a'.repeat(501)] }),
      validateRefinement({ observations: [' '] }),
      validateRefinement({ parameterChanges: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, 1])) }),
      validateRefinement({ anchorDeliverableId: 'x' }),
    ];
    for (const f of failures) {
      expect(f.ok).toBe(false);
      if (!f.ok) {
        expect(f.message).not.toMatch(VOSEO);
        expect(f.message.length).toBeGreaterThan(0);
      }
    }
    const tooMany = failures[0];
    expect(!tooMany.ok && tooMany.message).toBe('Puedes escribir como máximo 5 observaciones.');
  });
});

describe('codePointLength', () => {
  it('counts code points like PostgreSQL char_length', () => {
    expect(codePointLength('😀')).toBe(1);
    expect('😀'.length).toBe(2);
    expect(codePointLength('ñandú')).toBe(5);
  });
});
