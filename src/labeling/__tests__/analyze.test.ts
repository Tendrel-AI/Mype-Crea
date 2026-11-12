import { describe, expect, it } from 'vitest';
import { analyzeLabReports } from '../analyze';
import { RULES_VERSION } from '../rules';
import type { Basis, LabelResult, Measurement, Nutrient, OctagonKey, ParsedLabReport } from '../types';

const m = (nutrient: Nutrient, value: number, basis: Basis = 'per_100g', qualifier: '=' | '<' = '='): Measurement => ({
  nutrient, value, qualifier, basis, source: { parameter: nutrient, result: String(value), unit: '', page: 1 },
});

function report(over: Partial<ParsedLabReport> & { measurements?: Measurement[]; content?: ParsedLabReport['sample']['declaredContent'] }): ParsedLabReport {
  return {
    fileId: 'f1', reportNumber: '121635a', laboratory: null, issuedAt: '2026-01-10',
    sample: { description: null, lot: null, declaredContent: over.content ?? null, state: null, densityGPerMl: null, ...over.sample },
    kind: 'nutritional', measurements: over.measurements ?? [], otherParameters: [], issues: [], ...over,
  } as ParsedLabReport;
}

const drink = (density: number | null = 1.0247) =>
  report({
    content: { amount: 330, unit: 'ml' },
    sample: { description: null, lot: null, declaredContent: { amount: 330, unit: 'ml' }, state: null, densityGPerMl: density },
    measurements: [m('protein', 0.02), m('total_fat', 0.01), m('cholesterol', 0.01, 'per_100g', '<'), m('sodium', 13.89),
      m('total_sugars', 5.5), m('carbohydrate', 6.11), m('energy_kcal', 24.61)],
  });

const ok = (r: ReturnType<typeof analyzeLabReports>) => { if (!r.ok) throw new Error(r.message); return r; };
const oct = (r: LabelResult, k: OctagonKey) => r.octagons.find((o) => o.key === k)!;
const row = (r: LabelResult, n: Nutrient) => r.table.find((x) => x.nutrient === n)!;

describe('real drink 121635a', () => {
  const r = ok(analyzeLabReports([drink()]));
  it('is liquid, per 100 ml, 330 ml serving', () => {
    expect(r.rulesVersion).toBe(RULES_VERSION);
    expect(r.productState).toBe('liquid');
    expect(r.basis).toBe('per_100ml');
    expect(r.serving).toEqual({ amount: 330, unit: 'ml' });
  });
  it('verdicts', () => {
    expect(oct(r, 'alto_en_azucar')).toMatchObject({ status: 'required', reason: 'measured' });
    expect(oct(r, 'alto_en_azucar').value).toBeCloseTo(5.636, 2);
    expect(oct(r, 'alto_en_azucar').explanation).toContain('5,64 g por 100 ml');
    expect(oct(r, 'alto_en_sodio')).toMatchObject({ status: 'not_required' });
    expect(oct(r, 'alto_en_sodio').value).toBeCloseTo(14.23, 1);
    expect(oct(r, 'alto_en_grasas_saturadas')).toMatchObject({ status: 'not_required', reason: 'bounded' });
    expect(oct(r, 'contiene_grasas_trans')).toMatchObject({ status: 'not_evaluated', reason: 'missing' });
    expect(r.octagons.map((o) => o.key)).toEqual(['alto_en_sodio', 'alto_en_azucar', 'alto_en_grasas_saturadas', 'contiene_grasas_trans']);
  });
  it('table', () => {
    expect(r.table.map((x) => x.label)).toEqual(['Energía', 'Proteína', 'Grasa total', 'Grasa saturada', 'Grasa trans', 'Carbohidratos', 'Azúcares totales', 'Sodio']);
    expect(row(r, 'energy_kcal')).toMatchObject({ per100: '25', perServing: '83' });
    expect(row(r, 'total_sugars')).toMatchObject({ per100: '5,6', perServing: '18,6' });
    expect(row(r, 'sodium')).toMatchObject({ per100: '14', perServing: '47' });
    expect(row(r, 'total_fat')).toMatchObject({ per100: '0', perServing: '0' });
    expect(row(r, 'saturated_fat')).toMatchObject({ per100: null, perServing: null });
  });
  it('notices', () => {
    const codes = r.notices.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(['missing_trans_fat', 'not_measured_saturated_fat', 'digesa_disclaimer', 'ntp_pending']));
    expect(codes).not.toContain('density_assumed');
  });
});

describe('several reports', () => {
  it('ignores microbiology and pH-only reports', () => {
    const micro = report({ fileId: 'm', reportNumber: 'MB-1', kind: 'microbiological' });
    const ph = report({ fileId: 'p', reportNumber: 'PH-1', kind: 'other_physicochemical' });
    const r = ok(analyzeLabReports([micro, drink(), ph]));
    expect(r.sources.map((s) => s.used)).toEqual([false, true, false]);
    expect(r.notices.filter((n) => n.message.startsWith('No usamos el informe'))).toHaveLength(2);
  });
  it('conflict: most recent wins, warning names both', () => {
    const a = report({ fileId: 'a', reportNumber: 'A', issuedAt: '2026-01-01', content: { amount: 100, unit: 'g' }, measurements: [m('sodium', 100)] });
    const b = report({ fileId: 'b', reportNumber: 'B', issuedAt: '2026-03-01', content: { amount: 100, unit: 'g' }, measurements: [m('sodium', 450)] });
    const r = ok(analyzeLabReports([a, b]));
    expect(oct(r, 'alto_en_sodio').status).toBe('required');
    const n = r.notices.find((x) => x.code === 'conflict_sodium')!;
    expect(n.severity).toBe('warning');
    expect(n.message).toContain('450');
    expect(n.message).toContain('100');
  });
  it('parse issues of used reports become warnings', () => {
    const d = { ...drink(), issues: [{ code: 'unknown_parameter' as const, message: 'No reconocimos «Foo».' }] };
    expect(ok(analyzeLabReports([d])).notices).toContainEqual(expect.objectContaining({ severity: 'warning', message: 'No reconocimos «Foo».' }));
  });
  it('all unusable -> failure', () => {
    const f = analyzeLabReports([
      report({ fileId: 'x', reportNumber: 'X1', kind: 'microbiological' }),
      report({ fileId: 'y', reportNumber: null, kind: 'unknown', issues: [{ code: 'no_text_layer', message: 'El PDF no tiene texto.' }] }),
    ]);
    expect(f.ok).toBe(false);
    if (!f.ok) {
      expect(f.message).toContain('X1');
      expect(f.message).toContain('El PDF no tiene texto.');
      expect(f.issues).toEqual([expect.objectContaining({ fileId: 'y', code: 'no_text_layer' })]);
    }
  });
});

describe('density', () => {
  it('missing -> warning and factor 1', () => {
    const r = ok(analyzeLabReports([drink(null)]));
    expect(r.notices).toContainEqual(expect.objectContaining({ code: 'density_assumed', severity: 'warning' }));
    expect(oct(r, 'alto_en_azucar').value).toBeCloseTo(5.5, 5);
  });
});

describe('KAN-50 §9 golden candidates', () => {
  const run = (state: 'solid' | 'liquid', na: number, sugar: number, sat: number, extra: Measurement[] = []) => {
    const basis: Basis = state === 'solid' ? 'per_100g' : 'per_100ml';
    const r = ok(analyzeLabReports([report({
      content: { amount: 100, unit: state === 'solid' ? 'g' : 'ml' },
      measurements: [m('sodium', na, basis), m('total_sugars', sugar, basis), m('saturated_fat', sat, basis), ...extra],
    })]));
    return r.octagons.filter((o) => o.status === 'required').map((o) => o.key);
  };
  const ALL = ['alto_en_sodio', 'alto_en_azucar', 'alto_en_grasas_saturadas'];
  it.each([
    ['G01', 'solid', 399, 9.9, 3.9, []],
    ['G02', 'solid', 400, 10, 4, ALL],
    ['G03', 'solid', 401, 10.1, 4.1, ALL],
    ['G04', 'liquid', 99, 4.9, 2.9, []],
    ['G05', 'liquid', 100, 5, 3, ALL],
    ['G06', 'liquid', 101, 5.1, 3.1, ALL],
    ['G07', 'solid', 120, 25, 1, ['alto_en_azucar']],
    ['G08', 'solid', 150, 7, 3.5, []],
    ['G09', 'liquid', 150, 7, 3.5, ALL],
    ['G10', 'solid', 500, 2, 1, ['alto_en_sodio']],
    ['G11', 'solid', 50, 22.4, 0.5, ['alto_en_azucar']],
    ['G12', 'solid', 380, 9, 4, ['alto_en_grasas_saturadas']],
    ['G20', 'liquid', 120, 6, 3.2, ALL],
  ] as const)('%s', (_id, state, na, sugar, sat, expected) => {
    expect(run(state, na, sugar, sat)).toEqual(expected);
  });
  it('G14 trans measured > 0 requires its own octagon (engine rule, not PA-02 review flow)', () => {
    expect(run('solid', 100, 2, 1, [m('trans_fat', 0.6)])).toEqual(['contiene_grasas_trans']);
  });
  it('trans 0 and "<" are not_required', () => {
    const t = (x: Measurement) => oct(ok(analyzeLabReports([report({ content: { amount: 100, unit: 'g' }, measurements: [x] })])), 'contiene_grasas_trans');
    expect(t(m('trans_fat', 0)).status).toBe('not_required');
    expect(t(m('trans_fat', 0.1, 'per_100g', '<')).status).toBe('not_required');
  });
});

describe('missing data and solids', () => {
  const solid = (ms: Measurement[]) => ok(analyzeLabReports([report({ content: { amount: 50, unit: 'g' }, measurements: ms })]));
  it('solid uses per 100 g and serving in g', () => {
    const r = solid([m('sodium', 400)]);
    expect(r.basis).toBe('per_100g');
    expect(r.serving).toEqual({ amount: 50, unit: 'g' });
    expect(row(r, 'sodium')).toMatchObject({ per100: '400', perServing: '200' });
  });
  it('detection limit below threshold -> not_required; above -> not_evaluated', () => {
    expect(oct(solid([m('sodium', 5, 'per_100g', '<')]), 'alto_en_sodio')).toMatchObject({ status: 'not_required', reason: 'detection_limit' });
    expect(oct(solid([m('sodium', 500, 'per_100g', '<')]), 'alto_en_sodio')).toMatchObject({ status: 'not_evaluated', reason: 'detection_limit' });
  });
  it('bound not enough -> not_evaluated with warning', () => {
    const r = solid([m('total_fat', 20)]);
    expect(oct(r, 'alto_en_grasas_saturadas').status).toBe('not_evaluated');
    expect(r.notices).toContainEqual(expect.objectContaining({ code: 'missing_saturated_fat', severity: 'warning' }));
  });
  it('missing sodium -> not_evaluated, missing notice', () => {
    const r = solid([m('protein', 1)]);
    expect(oct(r, 'alto_en_sodio')).toMatchObject({ status: 'not_evaluated', reason: 'missing', value: null });
    expect(r.notices.find((n) => n.code === 'missing_sodium')!.message).toContain('«ALTO EN SODIO»');
  });
  it('fiber only when measured; qualifier < shown; energy fallback to lab', () => {
    const r = solid([m('fiber', 2), m('energy_kcal', 100), m('sodium', 0.3, 'per_100g', '<')]);
    expect(row(r, 'fiber').per100).toBe('2,0');
    expect(row(r, 'energy_kcal').per100).toBe('100');
    expect(row(r, 'sodium').per100).toBe('<0,3');
  });
  it('energy mismatch > 5 % -> info', () => {
    const r = solid([m('protein', 10), m('total_fat', 10), m('carbohydrate', 10), m('energy_kcal', 300)]);
    expect(row(r, 'energy_kcal').per100).toBe('170');
    expect(r.notices).toContainEqual(expect.objectContaining({ code: 'energy_mismatch', severity: 'info' }));
  });
  it('options.serving overrides', () => {
    expect(row(solid([m('sodium', 100)]) , 'sodium').perServing).toBe('50');
    const r = ok(analyzeLabReports([report({ content: { amount: 50, unit: 'g' }, measurements: [m('sodium', 100)] })], { serving: { amount: 20, unit: 'g' } }));
    expect(row(r, 'sodium').perServing).toBe('20');
  });
});
