import { describe, expect, it } from 'vitest';
import { layoutOctagonSet, octagonSizing } from '../octagon-geometry';
import type { OctagonKey } from '../types';

// Golden cases G1-G19 of pipeline/regulatory/octagon-geometry-spec.md §8.
const S: OctagonKey = 'alto_en_sodio';
const AZ: OctagonKey = 'alto_en_azucar';
const GS: OctagonKey = 'alto_en_grasas_saturadas';
const TR: OctagonKey = 'contiene_grasas_trans';
const rect = (widthMm: number, heightMm: number) => ({ shape: 'RECT' as const, widthMm, heightMm });

describe('layoutOctagonSet', () => {
  it('G2: three ALTO EN, left to right GS · AZÚCAR · SODIO, one shared 64x legend centred', () => {
    const l = layoutOctagonSet([S, AZ, GS]);
    expect(l.octagons).toEqual([{ key: GS, x: 0, y: 0 }, { key: AZ, x: 32, y: 0 }, { key: S, x: 64, y: 0 }]);
    expect(l.legends).toHaveLength(1);
    expect(l.legends[0]).toMatchObject({ x: 15, y: 31, w: 64, h: 6.6, lines: [{ text: 'EVITAR SU CONSUMO EXCESIVO', baseline: 35.25 }] });
    expect([l.width, l.height]).toEqual([94, 37.6]);
  });

  it('G3: two ALTO EN close the gap, row centred under the 64x legend', () => {
    const l = layoutOctagonSet([S, GS]);
    expect(l.octagons.map((o) => [o.key, o.x])).toEqual([[GS, 1], [S, 33]]);
    expect(l.legends[0]).toMatchObject({ x: 0, y: 31, w: 64 });
    expect([l.width, l.height]).toEqual([64, 37.6]);
  });

  it('G1: a single symbol has a two-line legend', () => {
    const l = layoutOctagonSet([S]);
    expect(l.legends[0].lines).toEqual([{ text: 'EVITAR SU CONSUMO', baseline: 33.85 }, { text: 'EXCESIVO', baseline: 36.65 }]);
    expect([l.width, l.height]).toEqual([30, 37.6]);
  });

  it('G4: one ALTO EN + trans is one column', () => {
    const l = layoutOctagonSet([AZ, TR]);
    expect(l.octagons).toEqual([{ key: AZ, x: 0, y: 0 }, { key: TR, x: 0, y: 38.6 }]);
    expect(l.legends.map((g) => g.lines.map((x) => x.text))).toEqual([['EVITAR SU CONSUMO', 'EXCESIVO'], ['EVITAR SU CONSUMO']]);
    expect([l.width, l.height]).toEqual([30, 76.2]);
  });

  it('G5: all four, trans right-aligned under SODIO with its own legend', () => {
    const l = layoutOctagonSet([S, AZ, GS, TR]);
    expect(l.octagons.at(-1)).toEqual({ key: TR, x: 64, y: 38.6 });
    expect(l.legends.at(-1)).toMatchObject({ x: 64, y: 69.6, w: 30, lines: [{ text: 'EVITAR SU CONSUMO', baseline: 73.85 }] });
    expect([l.width, l.height]).toEqual([94, 76.2]);
  });

  it('G15: two ALTO EN + trans under SODIO', () => {
    const l = layoutOctagonSet([GS, S, TR]);
    expect(l.octagons.at(-1)).toEqual({ key: TR, x: 33, y: 38.6 });
    expect([l.width, l.height]).toEqual([64, 76.2]);
  });

  it('trans alone has no row', () => {
    const l = layoutOctagonSet([TR]);
    expect(l.octagons).toEqual([{ key: TR, x: 0, y: 0 }]);
    expect([l.width, l.height]).toEqual([30, 37.6]);
  });

  it('G19: white base adds x on every side and shifts the set by (1, 1)', () => {
    const l = layoutOctagonSet([S], { whiteBase: true });
    expect(l.plate).toEqual({ x: 0, y: 0, w: 32, h: 39.6 });
    expect(l.octagons[0]).toMatchObject({ x: 1, y: 1 });
    expect([l.width, l.height]).toEqual([32, 39.6]);
  });

  it('rejects an empty set', () => {
    expect(() => layoutOctagonSet([])).toThrow();
  });
});

describe('octagonSizing', () => {
  it.each([
    ['G1', rect(120, 100), 'S25', 12_000_000, '120,00000'],
    ['G6 (50 cm² boundary)', rect(100, 50), 'S20', 5_000_000, '50,00000'],
    ['G8 (100 cm² boundary)', rect(100, 100), 'S25', 10_000_000, '100,00000'],
    ['G9 (200 cm² boundary)', rect(200, 100), 'S30', 20_000_000, '200,00000'],
    ['G16 (cylinder)', { shape: 'CYLINDER' as const, heightMm: 80, circumferenceMm: 200 }, 'S20', 6_400_000, '64,00000'],
    ['G17 (cylinder at 50 cm²)', { shape: 'CYLINDER' as const, heightMm: 50, circumferenceMm: 250 }, 'S20', 5_000_000, '50,00000'],
  ])('%s', (_id, face, sizeClass, areaA3, areaCm2) => {
    const r = octagonSizing([S], face);
    expect(r).toMatchObject({ status: 'OK', placement: 'LABEL', sizeClass, areaA3, areaCm2, message: null });
  });

  it('G1: x and set size in mm', () => {
    const r = octagonSizing([S], rect(120, 100));
    expect(r.sizeMm).toBe(25);
    expect(r.xMm).toBeCloseTo(0.8333, 4);
    expect(r.setMm).toEqual({ width: 25, height: 31.3333 });
  });

  it('G7: just under 50 cm² goes to the outer package at 30 mm', () => {
    const r = octagonSizing([S], rect(99.9, 50));
    expect(r).toMatchObject({ status: 'OK', sizeClass: 'SMALL', placement: 'CONTAINER', sizeMm: 30, areaA3: 4_995_000, areaCm2: '49,95000' });
    expect(r.message).toContain('envase mayor');
    expect(r.message).toContain('transporte');
  });

  it('G10: trans on a label under 50 cm² is manual review (TBD-3)', () => {
    expect(octagonSizing([TR], rect(60, 60))).toMatchObject({ status: 'MANUAL_REVIEW', sizeClass: 'SMALL', areaCm2: '36,00000' });
  });

  it('G11: a set taller than the face is manual review, never shrunk', () => {
    const r = octagonSizing([S, AZ, GS, TR], rect(120, 45));
    expect(r).toMatchObject({ status: 'MANUAL_REVIEW', sizeClass: 'S20', sizeMm: 20, setMm: { width: 62.6667, height: 50.8 } });
    expect(r.message).toContain('no caben');
  });

  it('fit check is exact at the edge: three ALTO EN at S20 need 62.67 mm of width', () => {
    expect(octagonSizing([S, AZ, GS], rect(62.6, 100)).status).toBe('MANUAL_REVIEW');
    expect(octagonSizing([S, AZ, GS], rect(62.7, 100)).status).toBe('OK');
  });

  it('G12: more than one decimal is rejected, not rounded', () => {
    expect(octagonSizing([S], rect(100.05, 50))).toMatchObject({ status: 'INVALID_INPUT', sizeClass: null });
    expect(octagonSizing([S], rect(0, 50)).status).toBe('INVALID_INPUT');
    expect(octagonSizing([S], rect(Number.NaN, 50)).status).toBe('INVALID_INPUT');
  });

  it('G13: no front face → size unknown, with a notice', () => {
    const r = octagonSizing([S]);
    expect(r).toMatchObject({ status: 'SIZE_UNKNOWN', sizeClass: null, setMm: null });
    expect(r.message).toContain('cara frontal');
  });

  it('G18: other shapes are manual review and quote the formula', () => {
    expect(octagonSizing([S], { shape: 'TRIANGLE' }).message).toContain('A (Base) x B (Altura) / 2');
  });

  it('G19: white base enters the set size', () => {
    expect(octagonSizing([S], rect(120, 100), { whiteBase: true }).setMm).toEqual({ width: 26.6667, height: 33 });
  });
});
