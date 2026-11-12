import type { OctagonKey } from './types';

/**
 * Octagon set layout and print size. Pure, deterministic; no floating point in any regulatory comparison.
 * Spec: pipeline/regulatory/octagon-geometry-spec.md (rule ids G-* cited inline). Layout is in units of x
 * (x = S / 30, G-SIZE-01); millimetres appear only in the sizing result.
 */

export type FrontFace =
  | { readonly shape: 'RECT'; readonly widthMm: number; readonly heightMm: number }
  | { readonly shape: 'CYLINDER'; readonly heightMm: number; readonly circumferenceMm: number }
  /** Shapes v1 does not compute (G-AREA-04): always MANUAL_REVIEW with the formula quoted. */
  | { readonly shape: 'TRIANGLE' | 'TRAPEZOID' | 'COMPOSITE' };

export type SizeClass = 'SMALL' | 'S20' | 'S25' | 'S30';

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface LegendBox extends Box {
  readonly lines: ReadonlyArray<{ readonly text: string; readonly baseline: number }>;
}

export interface OctagonSetLayout {
  /** Set size in x units, white base included. */
  readonly width: number;
  readonly height: number;
  /** White plate behind the set (G-OCT-08), or null. */
  readonly plate: Box | null;
  /** Top-left corner of each 30x30 symbol box. */
  readonly octagons: ReadonlyArray<{ readonly key: OctagonKey; readonly x: number; readonly y: number }>;
  readonly legends: ReadonlyArray<LegendBox>;
}

const OCT = 30; // G-OCT-01
const GAP_ROW = 2; // G-SET-02
const GAP = 1; // G-LEG-03, G-SET-05
const LEG_H = 6.6; // G-LEG-02
const SHARED_W = 64; // G-SET-04 (TBD-2 resolved 2026-11-12)
const EXCESIVO = 'EVITAR SU CONSUMO EXCESIVO';
const CONSUMO = 'EVITAR SU CONSUMO';

/** Left-to-right order of the ALTO EN row: sodio is rightmost (G-SET-01). */
const ROW_ORDER: ReadonlyArray<OctagonKey> = ['alto_en_grasas_saturadas', 'alto_en_azucar', 'alto_en_sodio'];
const TRANS: OctagonKey = 'contiene_grasas_trans';

/** Section 4.1 layout algorithm. Throws on an empty set: callers render nothing when no warning is required. */
export function layoutOctagonSet(warnings: ReadonlyArray<OctagonKey>, opts: { whiteBase?: boolean } = {}): OctagonSetLayout {
  const row = ROW_ORDER.filter((k) => warnings.includes(k));
  const trans = warnings.includes(TRANS);
  if (row.length === 0 && !trans) throw new Error('layoutOctagonSet: no warnings');
  const n = row.length;
  const o = opts.whiteBase ? 1 : 0; // G-OCT-08: everything shifts by (x, x)

  const rowW = n >= 1 ? (OCT + GAP_ROW) * n - GAP_ROW : OCT;
  const boxW = n >= 2 ? SHARED_W : OCT;
  const w = Math.max(rowW, boxW);
  const rowL = (w - rowW) / 2;
  const boxL = (w - boxW) / 2;
  const legendTop = OCT + GAP;

  const octagons: Array<OctagonSetLayout['octagons'][number]> = row.map((key, i) => ({ key, x: o + rowL + (OCT + GAP_ROW) * i, y: o }));
  const legends: LegendBox[] = [];
  if (n === 1) legends.push(legend(o, o + legendTop, OCT, [[CONSUMO, 2.85], ['EXCESIVO', 5.65]])); // G-LEG-04
  if (n >= 2) legends.push(legend(o + boxL, o + legendTop, SHARED_W, [[EXCESIVO, 4.25]])); // G-SET-03

  let h = OCT + GAP + LEG_H;
  if (trans) {
    const yT = n >= 1 ? h + GAP : 0;
    const xT = n >= 1 ? rowL + rowW - OCT : 0; // G-SET-05: right-aligned with the rightmost octagon
    octagons.push({ key: TRANS, x: o + xT, y: o + yT });
    legends.push(legend(o + xT, o + yT + legendTop, OCT, [[CONSUMO, 4.25]])); // G-LEG-05
    h = yT + OCT + GAP + LEG_H;
  }
  return {
    width: round(w + 2 * o),
    height: round(h + 2 * o),
    plate: o ? { x: 0, y: 0, w: round(w + 2), h: round(h + 2) } : null,
    octagons,
    legends,
  };
}

function legend(x: number, y: number, w: number, lines: ReadonlyArray<readonly [string, number]>): LegendBox {
  return { x, y, w, h: LEG_H, lines: lines.map(([text, dy]) => ({ text, baseline: round(y + dy) })) };
}

/** Layout sums of 0.1-step values pick up float noise (31 + 6.6 + 1); 4 decimals is far below print precision. */
export const round = (v: number) => Math.round(v * 1e4) / 1e4;

// ---- Size (section 2) ----

export interface OctagonSizing {
  readonly status: 'OK' | 'MANUAL_REVIEW' | 'SIZE_UNKNOWN' | 'INVALID_INPUT';
  readonly sizeClass: SizeClass | null;
  /** LABEL: on this label. CONTAINER: on the outer package (G-SIZE-02). */
  readonly placement: 'LABEL' | 'CONTAINER' | null;
  /** Octagon width S in mm (G-SIZE-01), and x = S / 30. */
  readonly sizeMm: 20 | 25 | 30 | null;
  readonly xMm: number | null;
  /** Compared area as an integer in 0.001 mm² (G-AREA-05) and as shown to the user, «49,95000» cm² (G-AREA-06). */
  readonly areaA3: number | null;
  readonly areaCm2: string | null;
  /** Set bounding box in mm (white base included), when the size is known. */
  readonly setMm: { readonly width: number; readonly height: number } | null;
  /** Spanish, tuteo; null when status is OK and placement is LABEL. */
  readonly message: string | null;
}

const OTHER_SHAPES: Record<'TRIANGLE' | 'TRAPEZOID' | 'COMPOSITE', string> = {
  TRIANGLE: 'triángulo, el área es A (Base) x B (Altura) / 2',
  TRAPEZOID: 'trapecio, el área es B (Alto) x [A (Base menor) + C (Base mayor)] / 2',
  COMPOSITE: 'forma compuesta, el área es la suma de sus partes A1 + A2 (rombo: C x D / 2; elipse: A x B x π)',
};

const SIZE_BY_CLASS = { SMALL: 30, S20: 20, S25: 25, S30: 30 } as const; // MAP Cuadro 2

const MSG = {
  unknown: 'El tamaño de impresión de los octógonos depende del área de la cara frontal de tu etiqueta: 20, 25 o 30 mm de ancho cada uno.',
  invalid: 'Ingresa las medidas de la cara frontal en milímetros, mayores que cero y con un decimal como máximo.',
  container: 'Tu etiqueta mide menos de 50 cm²: los octógonos no van en ella, sino en el envase mayor que contiene el producto, a 30 mm de ancho. Un envase que solo sirve para transporte no los lleva, salvo que también se use para exhibir el producto en la venta.',
  transSmall: 'La advertencia «Contiene grasas trans» en una etiqueta menor de 50 cm² necesita revisión manual: la norma no fija su tamaño ni su ubicación en ese caso.',
} as const;

const EMPTY = { sizeClass: null, placement: null, sizeMm: null, xMm: null, areaA3: null, areaCm2: null, setMm: null } as const;

export function octagonSizing(warnings: ReadonlyArray<OctagonKey>, frontFace?: FrontFace, opts: { whiteBase?: boolean } = {}): OctagonSizing {
  const layout = layoutOctagonSet(warnings, opts);
  if (!frontFace) return { status: 'SIZE_UNKNOWN', ...EMPTY, message: MSG.unknown }; // G-AREA-07
  if (frontFace.shape !== 'RECT' && frontFace.shape !== 'CYLINDER') {
    return { status: 'MANUAL_REVIEW', ...EMPTY, message: `Para una cara frontal con forma de ${OTHER_SHAPES[frontFace.shape]}. Esta forma necesita revisión manual.` }; // G-AREA-04
  }

  const isRect = frontFace.shape === 'RECT';
  const a10 = tenths(isRect ? frontFace.widthMm : frontFace.heightMm);
  const b10 = tenths(isRect ? frontFace.heightMm : frontFace.circumferenceMm);
  if (a10 === null || b10 === null) return { status: 'INVALID_INPUT', ...EMPTY, message: MSG.invalid }; // G-AREA-05

  const areaA3 = isRect ? 10 * a10 * b10 : 4 * a10 * b10;
  const sizeClass: SizeClass = areaA3 < 5_000_000 ? 'SMALL' : areaA3 < 10_000_000 ? 'S20' : areaA3 < 20_000_000 ? 'S25' : 'S30';
  const sizeMm = SIZE_BY_CLASS[sizeClass];
  const known = {
    sizeClass,
    sizeMm,
    xMm: sizeMm / 30,
    areaA3,
    areaCm2: `${Math.floor(areaA3 / 100_000)},${String(areaA3 % 100_000).padStart(5, '0')}`,
    setMm: { width: round((layout.width * sizeMm) / 30), height: round((layout.height * sizeMm) / 30) },
  };

  if (sizeClass === 'SMALL') {
    if (warnings.includes(TRANS)) return { status: 'MANUAL_REVIEW', ...known, placement: null, message: MSG.transSmall }; // G-SIZE-04, TBD-3 resolved
    return { status: 'OK', ...known, placement: 'CONTAINER', message: MSG.container }; // G-SIZE-02/03
  }

  // G-POS-03 fit check in hundredths of a mm, integers only: set mm = units * S / 30, so 100·set = units10 * S / 3.
  const faceW100 = isRect ? a10 * 10 : 4 * b10; // G-AREA-08: cylinder face = 40 % of the circumference
  const faceH100 = isRect ? b10 * 10 : a10 * 10;
  const tooWide = Math.round(layout.width * 10) * sizeMm > 3 * faceW100;
  const tooTall = Math.round(layout.height * 10) * sizeMm > 3 * faceH100;
  if (tooWide || tooTall) {
    const mm = (v: number) => v.toFixed(2).replace('.', ',');
    return {
      status: 'MANUAL_REVIEW', ...known, placement: 'LABEL',
      message: `Los octógonos (${mm(known.setMm.width)} × ${mm(known.setMm.height)} mm) no caben en la cara frontal (${mm(faceW100 / 100)} × ${mm(faceH100 / 100)} mm) sin reducirse por debajo del tamaño que exige la norma. Necesita revisión manual.`,
    };
  }
  return { status: 'OK', ...known, placement: 'LABEL', message: null };
}

/** Millimetres → integer tenths; null unless positive, finite and with at most one decimal (never rounded, G-AREA-05). */
function tenths(mm: number): number | null {
  if (!Number.isFinite(mm) || mm <= 0) return null;
  const t = Math.round(mm * 10);
  return Math.abs(mm * 10 - t) < 1e-6 ? t : null; // tolerance only absorbs binary float error (99.9 * 10 = 999.0000000000001)
}
