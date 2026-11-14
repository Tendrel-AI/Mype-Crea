import { CAP_HEIGHT, GLYPHS, UNITS_PER_EM } from './octagon-glyphs';
import { layoutOctagonSet, type Box, type LegendBox } from './octagon-geometry';
import type { OctagonKey } from './types';

/**
 * One self-contained SVG for the whole warning set (G-SET-07, TBD-5 resolved 2026-11-12): no <text>, no fonts,
 * no images or scripts; text is drawn as TeX Gyre Heros Bold outlines (G-FONT-03/04). viewBox is in units of x;
 * pass `xMm` (from octagonSizing) to get a print-size width/height in mm.
 * Spec: pipeline/regulatory/octagon-geometry-spec.md.
 */

const BLACK = '#000000';
const WHITE = '#FFFFFF'; // G-OCT-04

/** Exact lines and the A-dimensioned width of the widest one (G-TXT-01). */
const SYMBOL_TEXT: Record<OctagonKey, { readonly lines: ReadonlyArray<string>; readonly target: number }> = {
  alto_en_sodio: { lines: ['ALTO EN', 'SODIO'], target: 18 },
  alto_en_azucar: { lines: ['ALTO EN', 'AZÚCAR'], target: 18 },
  alto_en_grasas_saturadas: { lines: ['ALTO EN', 'GRASAS', 'SATURADAS'], target: 25 },
  contiene_grasas_trans: { lines: ['CONTIENE', 'GRASAS', 'TRANS'], target: 21 },
};
const BASELINES: Record<number, ReadonlyArray<number>> = { 2: [14, 19], 3: [12.5, 16.5, 20.5] }; // G-TXT-02
const OCT_CAP = 3; // G-TXT-01
const LEG_CAP = 1.9; // G-LEG-04/05, G-SET-03
const LEG_MARGIN = 3; // G-LEG-06: legend at most box width − 3x
const K_MIN = 0.9;
const K_MAX = 1.1; // G-TXT-05

const NAMES: Record<OctagonKey, string> = {
  alto_en_sodio: 'Alto en sodio',
  alto_en_azucar: 'Alto en azúcar',
  alto_en_grasas_saturadas: 'Alto en grasas saturadas',
  contiene_grasas_trans: 'Contiene grasas trans',
};

/** Spoken description of the set, in MAP priority order (sodio, azúcar, grasas saturadas, then trans). */
export function octagonSetLabel(warnings: ReadonlyArray<OctagonKey>): string {
  const high = (['alto_en_sodio', 'alto_en_azucar', 'alto_en_grasas_saturadas'] as const).filter((k) => warnings.includes(k));
  const parts = high.length ? [`${high.map((k) => NAMES[k]).join(', ')}. Evitar su consumo excesivo.`] : [];
  if (warnings.includes('contiene_grasas_trans')) parts.push(`${NAMES.contiene_grasas_trans}. Evitar su consumo.`);
  return `Octógonos: ${parts.join(' ')}`;
}

export function octagonSetSvg(warnings: ReadonlyArray<OctagonKey>, opts: { whiteBase?: boolean; xMm?: number } = {}): string {
  const layout = layoutOctagonSet(warnings, opts);
  const size = opts.xMm ? ` width="${n(layout.width * opts.xMm)}mm" height="${n(layout.height * opts.xMm)}mm"` : '';
  const body = [
    layout.plate ? rect(layout.plate, WHITE) : '',
    ...layout.octagons.map(({ key, x, y }) => symbol(key, x, y)),
    ...layout.legends.map(legend),
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(layout.width)} ${n(layout.height)}"${size} role="img" aria-label="${octagonSetLabel(warnings)}">${body}</svg>`;
}

function symbol(key: OctagonKey, x: number, y: number): string {
  const { lines, target } = SYMBOL_TEXT[key];
  // G-OCT-02: black 30 (outer line), white 28 (ring), black 26 (field), concentric.
  const rings = ([[30, BLACK], [28, WHITE], [26, BLACK]] as const).map(([w, fill]) => `<polygon points="${octagon(x + 15, y + 15, w)}" fill="${fill}"/>`);
  const k = scaleFor(lines, OCT_CAP, target, true);
  const text = lines.map((t, i) => line(t, x + 15, y + BASELINES[lines.length][i], OCT_CAP, k, WHITE));
  return rings.join('') + text.join('');
}

function legend(box: LegendBox): string {
  const k = scaleFor(box.lines.map((l) => l.text), LEG_CAP, box.w - LEG_MARGIN, false);
  // G-LEG-02: x/2 border drawn inside the outer edges.
  const frame = `<rect x="${n(box.x + 0.25)}" y="${n(box.y + 0.25)}" width="${n(box.w - 0.5)}" height="${n(box.h - 0.5)}" fill="${WHITE}" stroke="${BLACK}" stroke-width="0.5"/>`;
  return frame + box.lines.map((l) => line(l.text, box.x + box.w / 2, l.baseline, LEG_CAP, k, BLACK)).join('');
}

/** G-TXT-04 / G-LEG-06: one horizontal scale for every line of a symbol or legend; G-TXT-05 guard. */
function scaleFor(lines: ReadonlyArray<string>, cap: number, width: number, exact: boolean): number {
  const widest = Math.max(...lines.map((t) => advance(t) * unitScale(cap)));
  const k = exact || widest > width ? width / widest : 1;
  if (k < K_MIN || k > K_MAX) throw new Error(`octagon text scale ${k.toFixed(3)} out of [${K_MIN}, ${K_MAX}]: wrong font`);
  return k;
}

/** Font units → x units for a given cap height (G-FONT-02). */
const unitScale = (cap: number) => cap / CAP_HEIGHT;

const advance = (text: string) => [...text].reduce((sum, ch) => sum + glyph(ch).advance, 0);

function glyph(ch: string) {
  const g = GLYPHS[ch];
  if (!g) throw new Error(`octagon glyph missing for «${ch}»: regenerate src/labeling/octagon-glyphs.ts`);
  return g;
}

/** A centred line of outlined glyphs; advance widths only, no kerning (G-TXT-04). */
function line(text: string, cx: number, baseline: number, cap: number, k: number, fill: string): string {
  const s = unitScale(cap);
  let pen = 0;
  const paths = [...text].map((ch) => {
    const g = glyph(ch);
    const out = g.d ? `<path transform="translate(${pen})" d="${g.d}"/>` : '';
    pen += g.advance;
    return out;
  });
  const x0 = cx - (pen * s * k) / 2;
  return `<g fill="${fill}" transform="translate(${n(x0)} ${n(baseline)}) scale(${n(s * k, 6)} ${n(s, 6)})">${paths.join('')}</g>`;
}

/** G-OCT-03: regular octagon of width w centred at (cx, cy), flat top and bottom. */
function octagon(cx: number, cy: number, w: number): string {
  const h = w / 2;
  const c = w / (2 + Math.SQRT2);
  return [[-h + c, -h], [h - c, -h], [h, -h + c], [h, h - c], [h - c, h], [-h + c, h], [-h, h - c], [-h, -h + c]]
    .map(([dx, dy]) => `${n(cx + dx)},${n(cy + dy)}`).join(' ');
}

const rect = (b: Box, fill: string) => `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="${fill}"/>`;

const n = (v: number, digits = 4) => String(Math.round(v * 10 ** digits) / 10 ** digits);
