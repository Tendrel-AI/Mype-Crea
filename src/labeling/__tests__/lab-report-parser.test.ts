import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PdfPage } from '../pdf-text';
import { parseLabReportText } from '../parse-lab-report-text';
import { parseLabReportPdf } from '../lab-report-parser';

const fixture = (n: string): PdfPage[] => JSON.parse(readFileSync(join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

// Synthetic page: header at y=500; rows are [y, param, result, unit].
type R = [number, string, string, string];
const synth = (rows: R[], opts: { header?: boolean; extra?: PdfPage } = {}): PdfPage => [
  ...(opts.header === false
    ? []
    : [
        { text: 'PARÁMETRO', x: 70, y: 500 },
        { text: 'Resultado', x: 180, y: 500 },
        { text: 'UNIDAD', x: 240, y: 500 },
        { text: 'MÉTODO', x: 300, y: 500 },
      ]),
  ...rows.flatMap(([y, p, r, u]) => [
    ...(p ? [{ text: p, x: 30, y }] : []),
    ...(r ? [{ text: r, x: 195, y }] : []),
    ...(u ? [{ text: u, x: 250, y }] : []),
    { text: 'MFQ-1', x: 300, y },
  ]),
  ...(opts.extra ?? []),
];
const one = (rows: R[]) => parseLabReportText([synth(rows)], 'f');

describe('real-layout fixtures', () => {
  it('121635a: full proximate analysis across two pages', () => {
    const r = parseLabReportText(fixture('121635a'), 'f');
    const m = Object.fromEntries(r.measurements.map((x) => [x.nutrient, x]));
    expect(r.kind).toBe('nutritional');
    expect(r.reportNumber).toBe('INF.DIV-FQ.121635a');
    expect(r.laboratory).toBe('Multianalityca');
    expect(r.issuedAt).toBe('2026-07-10');
    expect(r.sample).toMatchObject({ declaredContent: { amount: 330, unit: 'ml' }, state: 'liquid', densityGPerMl: 1.0247 });
    expect([m.protein.value, m.total_fat.value, m.sodium.value, m.total_sugars.value, m.carbohydrate.value, m.energy_kcal.value])
      .toEqual([0.02, 0.01, 13.89, 5.5, 6.11, 24.61]);
    expect(m.cholesterol).toMatchObject({ value: 0.01, qualifier: '<' });
    expect(r.measurements.every((x) => x.basis === 'per_100g')).toBe(true);
    expect(r.measurements).toHaveLength(7);
    expect(r.otherParameters).toEqual(expect.arrayContaining(['Vitamina C', 'Carbonatación', 'pH', 'Acidez']));
    expect(r.issues).toEqual([]);
  });
  it.each(['124559a', '124561a'])('%s: only pH/acidez', (n) => {
    const r = parseLabReportText(fixture(n), 'f');
    expect(r.kind).toBe('other_physicochemical');
    expect(r.measurements).toEqual([]);
  });
  it.each(['124558a', '124560a'])('%s: microbiology', (n) => {
    const r = parseLabReportText(fixture(n), 'f');
    expect(r.kind).toBe('microbiological');
    expect(r.measurements).toEqual([]);
    expect(r.otherParameters.length).toBeGreaterThan(0);
  });
});

describe('synthetic layouts', () => {
  it('merges wrapped parameter names and strips footnote markers', () => {
    const r = one([[400, '°¹²Azúcares totales', '', ''], [390, '(Glucosa+Sacarosa', '5,5', '%'], [380, 'a)', '', '']]);
    expect(r.measurements).toMatchObject([{ nutrient: 'total_sugars', value: 5.5 }]);
  });
  it('converts kJ to kcal and mg/kg to per 100 g', () => {
    const r = one([[400, 'Energía', '418,4', 'kJ/100g'], [380, 'Sodio', '1000', 'mg/kg']]);
    expect(r.measurements[0]).toMatchObject({ nutrient: 'energy_kcal', value: 100 });
    expect(r.measurements[1]).toMatchObject({ nutrient: 'sodium', value: 100, basis: 'per_100g' });
  });
  it('handles g/100mL, % (p/v) and decimal points', () => {
    const r = one([[400, 'Proteínas', '1.5', 'g/100mL'], [380, 'Grasa', '2,0', '% (p/v)']]);
    expect(r.measurements.map((m) => [m.value, m.basis])).toEqual([[1.5, 'per_100ml'], [2, 'per_100ml']]);
  });
  it('detects < qualifier and ignores annotations', () => {
    const r = one([[400, 'Grasa trans', '<0,01', 'g/100g'], [380, 'Proteína', '0,02', '(F: 6,25) %']]);
    expect(r.measurements[0]).toMatchObject({ qualifier: '<', value: 0.01 });
    expect(r.measurements[1]).toMatchObject({ qualifier: '=', value: 0.02, basis: 'per_100g' });
  });
  it('reports unknown unit, unknown parameter, unparsed value, duplicate', () => {
    const r = one([
      [420, 'Proteína', '1', 'furlongs'], [400, 'Zinc', '1', 'mg/kg'], [380, 'Grasa', 'abc', '%'],
      [360, 'Fibra', '2', '%'], [340, 'Fibra dietaria', '3', '%'],
    ]);
    expect(r.issues.map((i) => i.code)).toEqual(['unknown_unit', 'unknown_parameter', 'unparsed_value', 'duplicate_parameter']);
    expect(r.measurements).toMatchObject([{ nutrient: 'fiber', value: 2 }]);
  });
  it('no header -> unknown + no_results_table', () => {
    const r = parseLabReportText([synth([[400, 'Proteína', '1', '%']], { header: false })], 'f');
    expect(r.kind).toBe('unknown');
    expect(r.issues.map((i) => i.code)).toContain('no_results_table');
  });
  it('header on page 1 only: page 2 reuses the columns', () => {
    const r = parseLabReportText([synth([[400, 'Proteína', '1', '%']]), synth([[700, 'Sodio', '5', 'mg/100g']], { header: false })], 'f');
    expect(r.measurements.map((m) => [m.nutrient, m.source.page])).toEqual([['protein', 1], ['sodium', 2]]);
  });
});

const SAMPLES = '/Users/matias/Desktop/Mypes-crea/lab-report-samples';
describe('parseLabReportPdf', () => {
  it.skipIf(!existsSync(SAMPLES))('parses the real PDFs', async () => {
    for (const f of readdirSync(SAMPLES).filter((n) => n.endsWith('.pdf'))) {
      const r = await parseLabReportPdf(readFileSync(join(SAMPLES, f)), f);
      expect(r.issues, f).toEqual([]);
      if (f.startsWith('121635a')) expect(r.measurements).toHaveLength(7);
    }
  });
  it('garbage bytes -> unreadable_pdf, never throws', async () => {
    const r = await parseLabReportPdf(new Uint8Array([1, 2, 3]), 'g');
    expect(r.issues[0].code).toBe('unreadable_pdf');
  });
  it('PDF without text -> no_text_layer', async () => {
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF';
    const r = await parseLabReportPdf(new TextEncoder().encode(pdf), 's');
    expect(r.issues[0].code).toBe('no_text_layer');
    expect(r.issues[0].message).toContain('escaneado');
  });
});
