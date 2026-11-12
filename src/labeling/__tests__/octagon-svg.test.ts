import { describe, expect, it } from 'vitest';
import { octagonSvg } from '../octagon-svg';
import type { OctagonKey } from '../types';

const EXPECT: Record<OctagonKey, string[]> = {
  alto_en_sodio: ['ALTO EN', 'SODIO', 'EVITAR SU CONSUMO EXCESIVO', 'MINSA'],
  alto_en_azucar: ['ALTO EN', 'AZÚCAR', 'EVITAR SU CONSUMO EXCESIVO', 'MINSA'],
  alto_en_grasas_saturadas: ['ALTO EN', 'GRASAS', 'SATURADAS', 'EVITAR SU CONSUMO EXCESIVO', 'MINSA'],
  contiene_grasas_trans: ['CONTIENE', 'GRASAS TRANS', 'EVITAR SU CONSUMO', 'MINSA'],
};

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

describe('octagonSvg', () => {
  it.each(Object.keys(EXPECT) as OctagonKey[])('%s is well-formed, self-contained and has its texts', (key) => {
    const svg = octagonSvg(key);
    expect(wellFormed(svg)).toBe(true);
    for (const t of EXPECT[key]) expect(svg).toContain(t);
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/href=/);
    expect(svg).toContain('viewBox');
  });
});
