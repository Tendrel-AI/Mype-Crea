import type { PdfPage, TextItem } from './pdf-text';
import type { Basis, Measurement, Nutrient, ParseIssue, ParsedLabReport, ReportKind } from './types';

/** Pure: positioned text -> ParsedLabReport. No I/O, no LLM. */

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const MARKERS = /[°¹²³⁰-⁹*]/g;
const cleanParam = (s: string) => s.replace(MARKERS, '').replace(/\s+/g, ' ').trim();
const stripParens = (s: string) => s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const round = (n: number) => Number(n.toPrecision(12));

// ---------- dictionaries ----------
const NUTRIENT_SYNONYMS: Record<string, Nutrient> = {
  energia: 'energy_kcal', calorias: 'energy_kcal', 'valor energetico': 'energy_kcal',
  proteina: 'protein', proteinas: 'protein',
  grasa: 'total_fat', 'grasa total': 'total_fat', 'grasas totales': 'total_fat', lipidos: 'total_fat', 'extracto etereo': 'total_fat',
  'grasa saturada': 'saturated_fat', 'acidos grasos saturados': 'saturated_fat',
  'grasa trans': 'trans_fat', 'acidos grasos trans': 'trans_fat',
  carbohidratos: 'carbohydrate', 'carbohidratos totales': 'carbohydrate', 'hidratos de carbono': 'carbohydrate',
  azucar: 'total_sugars', azucares: 'total_sugars', 'azucar total': 'total_sugars', 'azucares totales': 'total_sugars',
  fibra: 'fiber', 'fibra dietaria': 'fiber', 'fibra dietetica': 'fiber',
  sodio: 'sodium', colesterol: 'cholesterol',
};
const OTHER_PARAM = /^(ph|acidez|solidos (totales|solubles)|brix|grados brix|ceniza|humedad|densidad|vitamina c|carbonatacion|recuento\b.*)$/;

interface UnitDef { mass: 'g' | 'mg' | 'kcal' | 'kj'; basis: Basis; factor: number }
const U = (mass: UnitDef['mass'], basis: Basis, factor = 1): UnitDef => ({ mass, basis, factor });
const UNITS: Record<string, UnitDef> = {
  '%': U('g', 'per_100g'), 'g/100g': U('g', 'per_100g'),
  'g/100ml': U('g', 'per_100ml'), '%(p/v)': U('g', 'per_100ml'),
  'mg/100g': U('mg', 'per_100g'), 'mg/100ml': U('mg', 'per_100ml'),
  'mg/kg': U('mg', 'per_100g', 0.1),
  'kcal/100g': U('kcal', 'per_100g'), 'kcal/100ml': U('kcal', 'per_100ml'),
  'kj/100g': U('kj', 'per_100g', 1 / 4.184), 'kj/100ml': U('kj', 'per_100ml', 1 / 4.184),
};
const lookupUnit = (raw: string) =>
  UNITS[raw.toLowerCase().replace(/\((?!p\/v\))[^)]*\)/g, '').replace(/\s+/g, '')];

/** Value in the nutrient's canonical unit, or null if the unit family does not fit. */
function toCanonical(n: Nutrient, v: number, u: UnitDef): number | null {
  if (n === 'energy_kcal') return u.mass === 'kcal' || u.mass === 'kj' ? v * u.factor : null;
  const canonMg = n === 'sodium' || n === 'cholesterol';
  if (u.mass === 'kcal' || u.mass === 'kj') return null;
  const mg = u.mass === 'mg' ? v * u.factor : v * u.factor * 1000;
  return canonMg ? mg : mg / 1000;
}

// ---------- layout ----------
interface Line { y: number; items: TextItem[] }
interface Columns { paramEnd: number; resultEnd: number; unitEnd: number }
interface Row { y: number; param: string[]; result: string; unit: string[]; cols: number; page: number }

const Y_TOL = 2.5;
const CONT_DIST = 14;

function groupLines(items: PdfPage): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Y_TOL) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

function headerColumns(line: Line, page: PdfPage): Columns | null {
  const find = (w: string) => line.items.find((i) => norm(i.text) === w);
  const p = find('parametro'), r = find('resultado'), u = find('unidad');
  if (!p || !r || !u) return null;
  // Method headers are often vertically offset from the PARÁMETRO line, so look at nearby items.
  const next = page.filter((i) => Math.abs(i.y - line.y) <= 8 && i.x > u.x + 1).sort((a, b) => a.x - b.x)[0];
  return { paramEnd: (p.x + r.x) / 2, resultEnd: (r.x + u.x) / 2, unitEnd: next ? (u.x + next.x) / 2 : Infinity };
}

/** Value text to the right of a «Label:» on the same line. */
function field(pages: PdfPage[], label: string): string | null {
  for (const page of pages) {
    for (const it of page) {
      if (norm(it.text).replace(/:$/, '') !== label) continue;
      const v = page
        .filter((o) => Math.abs(o.y - it.y) <= Y_TOL && o.x > it.x + 1)
        .sort((a, b) => a.x - b.x)[0];
      if (v && !v.text.trim().endsWith(':')) return v.text.trim();
    }
  }
  return null;
}

const num = (s: string) => Number(s.replace(',', '.'));

function parseMetadata(pages: PdfPage[]): Omit<ParsedLabReport, 'fileId' | 'kind' | 'measurements' | 'otherParameters' | 'issues'> {
  const all = pages.flat();
  const reportNumber = all.map((i) => /\bINF\.[\w.-]*\w/i.exec(i.text)?.[0]).find(Boolean) ?? null;
  const laboratory = all.some((i) => /multianalityca/i.test(i.text)) ? 'Multianalityca' : null;
  const d = /(\d{4})[/-](\d{2})[/-](\d{2})/.exec(field(pages, 'fecha de emision') ?? '');
  const c = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg)\b/i.exec(field(pages, 'contenido declarado') ?? '');
  const st = norm(field(pages, 'estado') ?? '');
  return {
    reportNumber,
    laboratory,
    issuedAt: d ? `${d[1]}-${d[2]}-${d[3]}` : null,
    sample: {
      description: field(pages, 'descripcion'),
      lot: field(pages, 'lote'),
      declaredContent: c ? { amount: num(c[1]), unit: c[2].toLowerCase() as 'ml' | 'l' | 'g' | 'kg' } : null,
      state: st.startsWith('liquid') ? 'liquid' : st.startsWith('solid') ? 'solid' : null,
      densityGPerMl: null,
    },
  };
}

/** Rebuilds table rows from positions; reuses the last header's columns on pages without one. */
function buildRows(pages: PdfPage[]): { rows: Row[]; headerFound: boolean } {
  const rows: Row[] = [];
  const allCols: Columns[] = [];
  let current: Columns | null = null;
  pages.forEach((page, pi) => {
    const lines = groupLines(page);
    const headers = lines.map((l) => ({ y: l.y, cols: headerColumns(l, page) })).filter((h): h is { y: number; cols: Columns } => !!h.cols);
    const pageRows: Row[] = [];
    const conts: Array<{ y: number; param: string; unit: string; cols: number }> = [];
    for (const line of lines) {
      if (headers.some((h) => h.y === line.y)) continue;
      // Own table's header = nearest one above; none above -> inherited from the previous page.
      const above = headers.filter((h) => h.y > line.y).sort((a, b) => a.y - b.y)[0];
      if (!above && headers.length) continue; // before the first header of this page
      const cols = above?.cols ?? current;
      if (!cols) continue;
      if (above && !allCols.includes(above.cols)) allCols.push(above.cols);
      const colsIdx = allCols.indexOf(cols);
      const cell = (lo: number, hi: number) =>
        line.items.filter((i) => i.x >= lo && i.x < hi).map((i) => i.text.trim()).join(' ').trim();
      const param = cell(-Infinity, cols.paramEnd), result = cell(cols.paramEnd, cols.resultEnd), unit = cell(cols.resultEnd, cols.unitEnd);
      if (/^nota/i.test(norm(param))) continue;
      if (!param && result) continue; // stray text (signatures, notes), not a table row
      if (result) pageRows.push({ y: line.y, param: [param], result, unit: [unit], cols: colsIdx, page: pi + 1 });
      else if (param || unit) conts.push({ y: line.y, param, unit, cols: colsIdx });
    }
    // Result-less lines (wrapped name/unit) join the nearest row of the same table.
    for (const c of conts) {
      const target = pageRows
        .filter((r) => r.cols === c.cols && Math.abs(r.y - c.y) <= CONT_DIST)
        .sort((a, b) => Math.abs(a.y - c.y) - Math.abs(b.y - c.y))[0];
      if (!target) continue;
      const above = c.y > target.y;
      if (c.param) above ? target.param.unshift(c.param) : target.param.push(c.param);
      if (c.unit) above ? target.unit.unshift(c.unit) : target.unit.push(c.unit);
    }
    rows.push(...pageRows);
    if (headers.length) current = headers.sort((a, b) => a.y - b.y)[0].cols;
  });
  return { rows, headerFound: allCols.length > 0 };
}

export function parseLabReportText(pages: PdfPage[], fileId: string): ParsedLabReport {
  const meta = parseMetadata(pages);
  const { rows, headerFound } = buildRows(pages);
  const measurements: Measurement[] = [];
  const otherParameters: string[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Set<Nutrient>();
  let density: number | null = null;
  let ufc = false;

  for (const row of rows) {
    const display = cleanParam(row.param.join(' '));
    const key = norm(stripParens(display));
    const unitRaw = row.unit.join(' ').trim();
    const unit = unitRaw.replace(/\s+/g, ' ');
    if (/ufc/i.test(unit)) ufc = true;
    const nutrient = NUTRIENT_SYNONYMS[key];
    if (!nutrient) {
      if (OTHER_PARAM.test(key)) {
        if (!otherParameters.includes(display)) otherParameters.push(display);
        const dv = key === 'densidad' && /^g\/ml$/i.test(stripParens(unit).replace(/\s+/g, '')) ? /^\d+(?:[.,]\d+)?/.exec(row.result) : null;
        if (dv && density === null) density = num(dv[0]);
      } else {
        issues.push({ code: 'unknown_parameter', message: `No reconocimos el parámetro «${display}», así que no se usó.`, detail: display });
      }
      continue;
    }
    const resultText = stripParens(row.result);
    const m = /^(<)?\s*(\d+(?:[.,]\d+)?)$/.exec(resultText);
    if (!m) {
      issues.push({ code: 'unparsed_value', message: `No pudimos leer el valor «${row.result}» de «${display}».`, detail: row.result });
      continue;
    }
    const def = lookupUnit(unit);
    const value = def ? toCanonical(nutrient, num(m[2]), def) : null;
    if (!def || value === null) {
      issues.push({ code: 'unknown_unit', message: `No reconocimos la unidad «${unit || 'vacía'}» de «${display}», así que no se usó.`, detail: unit });
      continue;
    }
    if (seen.has(nutrient)) {
      issues.push({ code: 'duplicate_parameter', message: `«${display}» aparece más de una vez en el informe; se usó el primer valor.`, detail: display });
      continue;
    }
    seen.add(nutrient);
    measurements.push({
      nutrient, value: round(value), qualifier: m[1] ? '<' : '=', basis: def.basis,
      source: { parameter: display, result: row.result, unit, page: row.page },
    });
  }

  const micro = ufc || pages.some((p) => p.some((i) => /^(resultados? )?microbiolog\w*$/.test(norm(i.text))));
  const kind: ReportKind = micro ? 'microbiological' : measurements.length ? 'nutritional' : otherParameters.length ? 'other_physicochemical' : 'unknown';
  if (!headerFound) {
    issues.push({ code: 'no_results_table', message: 'No encontramos la tabla de resultados en este informe.' });
  }
  return { fileId, ...meta, sample: { ...meta.sample, densityGPerMl: density }, kind, measurements, otherParameters, issues };
}
