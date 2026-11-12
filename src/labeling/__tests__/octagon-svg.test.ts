import { describe, expect, it } from 'vitest';
import { octagonSetLabel, octagonSetSvg } from '../octagon-svg';
import type { OctagonKey } from '../types';

// No XML parser is installed: check balanced tags and quoted attributes.
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  const stripped = xml.replace(/<\/?[a-zA-Z]+(?:\s+[\w:-]+="[^"<]*")*\s*\/?>/g, '');
  return stack.length === 0 && !/[<>]/.test(stripped);
}

const SETS: OctagonKey[][] = [
  ['alto_en_sodio'],
  ['alto_en_azucar'],
  ['alto_en_grasas_saturadas'],
  ['contiene_grasas_trans'],
  ['alto_en_sodio', 'alto_en_grasas_saturadas'],
  ['alto_en_sodio', 'alto_en_azucar', 'alto_en_grasas_saturadas', 'contiene_grasas_trans'],
];

describe('octagonSetSvg (G14)', () => {
  it.each(SETS)('%s is well-formed, self-contained and font-independent', (...keys) => {
    const svg = octagonSetSvg(keys, { whiteBase: true });
    expect(wellFormed(svg)).toBe(true);
    expect(svg).not.toMatch(/<text|<script|href=|MINSA|font-family/);
    expect(new Set(svg.match(/#[0-9A-Fa-f]{6}/g))).toEqual(new Set(['#000000', '#FFFFFF']));
    expect(svg).not.toMatch(/rotate|skew|matrix/);
  });

  it('draws three concentric octagons of widths 30/28/26 per symbol', () => {
    const svg = octagonSetSvg(['alto_en_sodio']);
    const xs = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => {
      const v = m[1].split(' ').map((p) => Number(p.split(',')[0]));
      return Math.round((Math.max(...v) - Math.min(...v)) * 1e3) / 1e3;
    });
    expect(xs).toEqual([30, 28, 26]);
  });

  it('one image for the whole set: one shared legend for several ALTO EN (G-SET-07)', () => {
    const svg = octagonSetSvg(['alto_en_sodio', 'alto_en_azucar']);
    expect(svg.match(/<rect/g)).toHaveLength(1);
    expect(svg.match(/<polygon/g)).toHaveLength(6);
  });

  it('prints in mm only when the size is known', () => {
    expect(octagonSetSvg(['alto_en_sodio'])).toContain('viewBox="0 0 30 37.6"');
    expect(octagonSetSvg(['alto_en_sodio'])).not.toContain('mm"');
    expect(octagonSetSvg(['alto_en_sodio'], { xMm: 25 / 30 })).toContain('width="25mm" height="31.3333mm"');
  });

  it('is deterministic', () => {
    expect(octagonSetSvg(SETS[5])).toBe(octagonSetSvg(SETS[5]));
  });
});

describe('octagonSetLabel', () => {
  it('reads the set in MAP priority order', () => {
    expect(octagonSetLabel(['alto_en_grasas_saturadas', 'contiene_grasas_trans', 'alto_en_sodio']))
      .toBe('Octógonos: Alto en sodio, Alto en grasas saturadas. Evitar su consumo excesivo. Contiene grasas trans. Evitar su consumo.');
  });
});
