import { describe, expect, it } from 'vitest';
import { BRIEF_CATALOG, briefFieldSpec, briefFromSnapshot, fieldRule, validateBriefValue } from '../brief';
import { buildDefaultRegistry } from '../orchestrator/bootstrap-registry';
import { buildAgentRequirementState, buildSnapshot } from './_fixtures';

const name = briefFieldSpec('business_name')!;

describe('brief catalog (KAN-26)', () => {
  it('is owned by the default registry, and every registry field is in the catalog', () => {
    const declared = new Set(
      buildDefaultRegistry().getFieldSchemas().flatMap((s) => [...s.requiredFields, ...s.optionalFields]),
    );
    expect([...declared].sort()).toEqual(BRIEF_CATALOG.map((f) => f.name).sort());
  });

  it('has unique names and no nutrition fields (KAN-37)', () => {
    const names = BRIEF_CATALOG.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => /nutri/i.test(n))).toBe(false);
  });

  it.each<[string, unknown, ReturnType<typeof validateBriefValue>]>([
    ['trims', '  Dulce Andino ', { ok: true, value: 'Dulce Andino' }],
    ['collapses tabs, line breaks and whitespace', 'Dulce\n\t\r  Andino', { ok: true, value: 'Dulce Andino' }],
    ['rejects a NUL (KAN-44)', 'Dulce\u0000Andino', { ok: false, message: '«Nombre del negocio» tiene caracteres no permitidos.' }],
    ['rejects an escape sequence (KAN-44)', 'Dulce\u001b[31mAndino', { ok: false, message: '«Nombre del negocio» tiene caracteres no permitidos.' }],
    ['rejects DEL and C1 controls (KAN-44)', 'Dulce\u007f\u0085', { ok: false, message: '«Nombre del negocio» tiene caracteres no permitidos.' }],
    ['composes to NFC', 'Café', { ok: true, value: 'Café' }],
    ['accepts exactly the max length', 'a'.repeat(120), { ok: true, value: 'a'.repeat(120) }],
    ['counts code points, not UTF-16 units', '😀'.repeat(120), { ok: true, value: '😀'.repeat(120) }],
    ['rejects over the max length', 'a'.repeat(121), { ok: false, message: '«Nombre del negocio» puede tener hasta 120 caracteres.' }],
    ['rejects blank', ' \n ', { ok: false, message: 'Escribe un valor para «Nombre del negocio».' }],
    ['rejects non-strings', 7, { ok: false, message: 'No pudimos validar este dato.' }],
    ['rejects null', null, { ok: false, message: 'No pudimos validar este dato.' }],
  ])('validateBriefValue %s', (_name, input, expected) => {
    expect(validateBriefValue(name, input)).toEqual(expected);
  });

  it('fieldRule: the catalog spec, else plain text up to 500 code points for a card field outside it (KAN-44)', () => {
    expect(fieldRule('business_name')).toBe(name);
    const tone = fieldRule('tone');
    expect(validateBriefValue(tone, '  cálido ')).toEqual({ ok: true, value: 'cálido' });
    expect(validateBriefValue(tone, 'a'.repeat(501)).ok).toBe(false);
    expect(validateBriefValue(tone, 3).ok).toBe(false);
  });

  it('projects a snapshot in catalog order, with status, value and source', () => {
    const snapshot = buildSnapshot({
      agentStates: {
        'logo-agent': buildAgentRequirementState({
          requiredFields: {
            business_name: { status: 'filled', value: 'Dulce Andino', confidence: 1, source: 'brief-panel' },
            style_keywords: { status: 'pending_confirmation', value: 'rústico', confidence: 0.7, source: 'chat-es' },
          },
          optionalFields: { color_palette: { status: 'filled', value: 'rojo', confidence: 0.95 } },
        }),
      },
    });
    const brief = briefFromSnapshot(snapshot);
    expect(brief.map((f) => f.name)).toEqual(BRIEF_CATALOG.map((f) => f.name));
    expect(brief.find((f) => f.name === 'business_name')).toMatchObject({ status: 'filled', value: 'Dulce Andino', source: 'brief-panel' });
    expect(brief.find((f) => f.name === 'style_keywords')).toMatchObject({ status: 'pending_confirmation', source: 'chat-es' });
    // Slots written before KAN-26 have no source.
    expect(brief.find((f) => f.name === 'color_palette')).toMatchObject({ value: 'rojo', source: null });
    expect(brief.find((f) => f.name === 'location')).toMatchObject({ status: 'empty', value: null, source: null });
  });
});
