import type { OctagonKey } from './types';

// Standalone, self-contained SVG (system fonts only, no images/scripts) so it can be overlaid on another graphic.
// Spec: pipeline/regulatory/KAN-50-regulatory-rules-spec.md §5 (R-TXT-01..03) and §6 (R-FMT-01).
// shortcut: MAP Anexo 1 proportions are graphic-only and not transcribed (PA-06); geometry here is approximate, replace with the official artwork once obtained.
// shortcut: Helvetica LT Std-Bold is not embeddable; we use a Helvetica/Arial bold stack.
// shortcut: «MINSA» is not in spec §5/§6 text; it is placed at the bottom of the octagon as in the published symbol, pending PA-06.
// shortcut: legend case follows R-TXT-03 (uppercase); R-TXT-05 statutory phrase is mixed case.
const LINES: Record<OctagonKey, { readonly top: string; readonly main: ReadonlyArray<string>; readonly legend: string }> = {
  alto_en_sodio: { top: 'ALTO EN', main: ['SODIO'], legend: 'EVITAR SU CONSUMO EXCESIVO' },
  alto_en_azucar: { top: 'ALTO EN', main: ['AZÚCAR'], legend: 'EVITAR SU CONSUMO EXCESIVO' },
  alto_en_grasas_saturadas: { top: 'ALTO EN', main: ['GRASAS', 'SATURADAS'], legend: 'EVITAR SU CONSUMO EXCESIVO' },
  contiene_grasas_trans: { top: '', main: ['CONTIENE', 'GRASAS TRANS'], legend: 'EVITAR SU CONSUMO' },
};

const FONT = "font-family=\"Helvetica, Arial, sans-serif\" font-weight=\"700\" text-anchor=\"middle\"";
// Regular octagon in a 200x200 box: corner cut = 200 * (1 - 1/(1+√2)) / 2 ≈ 29.3.
const OCT = (inset: number) => {
  const c = 29.3, a = inset, b = 200 - inset;
  return [[a + c, a], [b - c, a], [b, a + c], [b, b - c], [b - c, b], [a + c, b], [a, b - c], [a, a + c]].map((p) => p.join(',')).join(' ');
};

export function octagonSvg(key: OctagonKey): string {
  const { top, main, legend } = LINES[key];
  const rows = [...(top ? [top] : []), ...main];
  const size = (t: string) => (t.length > 9 ? 20 : t === 'ALTO EN' ? 22 : 26);
  const lineH = 30, start = 100 - ((rows.length - 1) * lineH) / 2 - 8;
  const text = rows.map((t, i) => `<text x="100" y="${start + i * lineH}" ${FONT} font-size="${size(t)}" fill="#fff">${t}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 250" role="img" aria-label="${rows.join(' ')}">`
    + `<polygon points="${OCT(0)}" fill="#fff"/><polygon points="${OCT(6)}" fill="#000"/>`
    + text
    + `<text x="100" y="172" ${FONT} font-size="14" fill="#fff">MINSA</text>`
    + `<rect x="2" y="208" width="196" height="38" fill="#fff" stroke="#000" stroke-width="3"/>`
    + `<text x="100" y="232" ${FONT} font-size="${legend.length > 20 ? 13 : 15}" fill="#000">${legend}</text></svg>`;
}
