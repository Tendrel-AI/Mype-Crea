import { ENERGY_FACTORS, ENERGY_MISMATCH, OCTAGON_KEYS, RULES_VERSION, TABLE_ROWS, THRESHOLDS } from './rules';
import type {
  AnalyzeOptions,
  Basis,
  LabelAnalysisFailure,
  LabelNotice,
  LabelResult,
  Measurement,
  Nutrient,
  NutritionRow,
  OctagonKey,
  OctagonVerdict,
  ParsedLabReport,
} from './types';

type Q = { value: number; qualifier: '=' | '<' };
type Serving = { amount: number; unit: 'ml' | 'g' };

const comma = (s: string) => s.replace('.', ',');
/** Up to 2 decimals, no trailing zeros, decimal comma (for sentences). */
const num = (v: number) => comma(String(Math.round(v * 100) / 100));
const unitOf = (n: Nutrient) => (n === 'sodium' || n === 'cholesterol' ? 'mg' : n === 'energy_kcal' ? 'kcal' : 'g');
const basisText = (b: Basis) => (b === 'per_100ml' ? 'por 100 ml' : 'por 100 g');
const label = (r: ParsedLabReport) => r.reportNumber ?? r.fileId;

/** PROVISIONAL rounding: kcal and mg integers, g one decimal, measured g < 0.05 shows "0"; '<' shows the limit. */
function format(q: Q | null, unit: 'kcal' | 'g' | 'mg'): string | null {
  if (!q) return null;
  if (q.qualifier === '<') return '<' + comma(String(Math.round(q.value * 1000) / 1000));
  if (unit === 'g') return q.value < 0.05 ? '0' : comma(q.value.toFixed(1));
  return String(Math.round(q.value));
}

function toLiters(c: { amount: number; unit: string }): Serving {
  return c.unit === 'l' ? { amount: c.amount * 1000, unit: 'ml' } : c.unit === 'kg' ? { amount: c.amount * 1000, unit: 'g' } : (c as Serving);
}

export function analyzeLabReports(
  reports: ReadonlyArray<ParsedLabReport>,
  options: AnalyzeOptions = {},
): LabelResult | LabelAnalysisFailure {
  const used = reports.filter((r) => r.measurements.length > 0);
  if (used.length === 0) return failure(reports);

  const notices: LabelNotice[] = [];
  const notice = (code: string, severity: 'info' | 'warning', message: string) => notices.push({ code, severity, message });

  for (const r of reports.filter((x) => !used.includes(x))) {
    notice(
      `report_not_used_${r.fileId}`,
      'info',
      `No usamos el informe ${label(r)} porque no trae nutrientes (${r.kind === 'microbiological' ? 'análisis microbiológico' : 'solo pH y acidez'}).`,
    );
  }
  for (const r of used) for (const i of r.issues) notice(`parse_issue_${r.fileId}_${i.code}`, 'warning', i.message);

  // Liquid vs solid (R-UNIT-02): declared content unit, then lab state, then solid by default.
  const declared = used.find((r) => r.sample.declaredContent)?.sample.declaredContent ?? null;
  let productState: 'liquid' | 'solid';
  if (declared) productState = declared.unit === 'ml' || declared.unit === 'l' ? 'liquid' : 'solid';
  else {
    const st = used.find((r) => r.sample.state)?.sample.state;
    productState = st ?? 'solid';
    if (!st) notice('state_assumed', 'warning', 'No pudimos saber si tu producto es sólido o líquido; lo tratamos como sólido.');
  }
  const basis: Basis = productState === 'liquid' ? 'per_100ml' : 'per_100g';

  // Density (only needed when a measurement is on the other basis).
  const density = used.find((r) => r.sample.densityGPerMl)?.sample.densityGPerMl ?? null;
  let densityAssumed = false;
  const convert = (m: Measurement): Q => {
    if (m.basis === basis) return { value: m.value, qualifier: m.qualifier };
    if (!density) densityAssumed = true;
    const d = density ?? 1;
    return { value: basis === 'per_100ml' ? m.value * d : m.value / d, qualifier: m.qualifier };
  };

  // Merge: most recent issuedAt wins (null last, ties keep input order).
  const ordered = [...used].sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''));
  const values = new Map<Nutrient, Q>();
  const chosenFrom = new Map<Nutrient, ParsedLabReport>();
  for (const r of ordered) {
    for (const m of r.measurements) {
      const q = convert(m);
      const prev = values.get(m.nutrient);
      if (!prev) {
        values.set(m.nutrient, q);
        chosenFrom.set(m.nutrient, r);
      } else if (chosenFrom.get(m.nutrient) !== r && (Math.abs(prev.value - q.value) > 1e-9 || prev.qualifier !== q.qualifier)) {
        const u = unitOf(m.nutrient);
        const show = (x: Q) => `${x.qualifier === '<' ? '<' : ''}${num(x.value)} ${u}`;
        notice(
          `conflict_${m.nutrient}`,
          'warning',
          `El informe ${label(chosenFrom.get(m.nutrient)!)} y el informe ${label(r)} traen valores distintos para ${labelOf(m.nutrient)}: ${show(prev)} y ${show(q)}. Usamos el del informe más reciente (${label(chosenFrom.get(m.nutrient)!)}).`,
        );
      }
    }
  }
  if (densityAssumed) {
    notice(
      'density_assumed',
      'warning',
      productState === 'liquid'
        ? 'El informe no trae la densidad; calculamos por 100 ml con 1 g/ml. Si tu producto es más denso, los valores reales por 100 ml serán algo mayores.'
        : 'El informe no trae la densidad; calculamos por 100 g con 1 g/ml. Si tu producto es menos denso, los valores reales por 100 g serán algo mayores.',
    );
  }

  const octagons = OCTAGON_KEYS.map((key) => verdict(key, values, basis, notice));

  // Energy: Codex factors when the three macros are measured, else the lab's value.
  const lab = values.get('energy_kcal') ?? null;
  const [p, f, c] = [values.get('protein'), values.get('total_fat'), values.get('carbohydrate')];
  let energy: Q | null = lab;
  if (p?.qualifier === '=' && f?.qualifier === '=' && c?.qualifier === '=') {
    const computed = p.value * ENERGY_FACTORS.protein + f.value * ENERGY_FACTORS.total_fat + c.value * ENERGY_FACTORS.carbohydrate;
    energy = { value: computed, qualifier: '=' };
    if (lab && Math.abs(computed - lab.value) / Math.max(lab.value, 1e-9) > ENERGY_MISMATCH) {
      notice('energy_mismatch', 'info', `La energía calculada (${num(computed)} kcal) difiere más de 5 % de la del informe (${num(lab.value)} kcal); mostramos la calculada.`);
    }
  }
  if (energy) values.set('energy_kcal', energy);

  const serving = resolveServing(options.serving ?? (declared ? toLiters(declared) : null), basis, density);
  const table: NutritionRow[] = TABLE_ROWS.filter((r) => !r.optional || values.has(r.nutrient)).map((r) => {
    const q = values.get(r.nutrient) ?? null;
    const scaled = q && serving ? { ...q, value: (q.value * serving.amount) / 100 } : null;
    return { nutrient: r.nutrient, label: r.label, unit: r.unit, per100: format(q, r.unit), perServing: format(scaled, r.unit) };
  });

  notice('digesa_disclaimer', 'info', 'Resultado referencial: verifica con DIGESA antes de imprimir tu etiqueta.');
  notice('ntp_pending', 'info', 'La tabla sigue de forma provisional la guía Codex CXG 2-1985; aún no revisamos la NTP 209.652:2025.');

  return {
    ok: true,
    rulesVersion: RULES_VERSION,
    productState,
    basis,
    serving: options.serving ?? (declared ? toLiters(declared) : null),
    table,
    octagons,
    notices,
    sources: reports.map((r) => ({ fileId: r.fileId, reportNumber: r.reportNumber, used: used.includes(r) })),
  };
}

/** Serving expressed in the basis unit (ml or g), converting with density when the units differ. */
function resolveServing(s: Serving | null, basis: Basis, density: number | null): Serving | null {
  if (!s) return null;
  const want = basis === 'per_100ml' ? 'ml' : 'g';
  if (s.unit === want) return s;
  const d = density ?? 1;
  return { amount: want === 'ml' ? s.amount / d : s.amount * d, unit: want };
}

const NAMES: Partial<Record<Nutrient, string>> = {
  sodium: 'sodio',
  total_sugars: 'azúcares totales',
  saturated_fat: 'grasa saturada',
  trans_fat: 'grasas trans',
  total_fat: 'grasa total',
  carbohydrate: 'carbohidratos',
};
const labelOf = (n: Nutrient) => NAMES[n] ?? TABLE_ROWS.find((r) => r.nutrient === n)?.label.toLowerCase() ?? n;
const TITLES: Partial<Record<Nutrient, string>> = { sodium: 'Sodio', total_sugars: 'Azúcares totales', saturated_fat: 'Grasa saturada', trans_fat: 'Grasas trans' };
const LEGEND: Record<OctagonKey, string> = {
  alto_en_sodio: 'ALTO EN SODIO',
  alto_en_azucar: 'ALTO EN AZÚCAR',
  alto_en_grasas_saturadas: 'ALTO EN GRASAS SATURADAS',
  contiene_grasas_trans: 'CONTIENE GRASAS TRANS',
};
/** Nutrient whose value is an upper bound when the evaluated one is missing. */
const BOUND_BY: Partial<Record<Nutrient, Nutrient>> = { saturated_fat: 'total_fat', total_sugars: 'carbohydrate' };

function verdict(
  key: OctagonKey,
  values: Map<Nutrient, Q>,
  basis: Basis,
  notice: (code: string, severity: 'info' | 'warning', message: string) => void,
): OctagonVerdict {
  const nutrient: Nutrient = { alto_en_sodio: 'sodium', alto_en_azucar: 'total_sugars', alto_en_grasas_saturadas: 'saturated_fat', contiene_grasas_trans: 'trans_fat' }[key] as Nutrient;
  const title = TITLES[nutrient]!;
  const u = unitOf(nutrient);
  const isTrans = nutrient === 'trans_fat';
  const threshold = isTrans ? null : THRESHOLDS[nutrient as 'sodium'][basis];
  const base = { key, nutrient, threshold, basis };
  const v = values.get(nutrient);
  const unmeasured = () =>
    notice(`missing_${nutrient}`, 'warning', `El informe no reporta ${labelOf(nutrient)}; por eso no evaluamos el octógono «${LEGEND[key]}».`);

  if (v && !isTrans) {
    const limit = threshold!;
    if (v.qualifier === '=') {
      const req = v.value >= limit;
      return { ...base, status: req ? 'required' : 'not_required', value: v.value, reason: 'measured', explanation: `${title}: ${num(v.value)} ${u} ${basisText(basis)}; el límite es ${num(limit)} ${u}, así que ${req ? 'lleva' : 'no lleva'} el octógono.` };
    }
    if (v.value < limit) {
      return { ...base, status: 'not_required', value: v.value, reason: 'detection_limit', explanation: `${title}: menos de ${num(v.value)} ${u} ${basisText(basis)} (límite de detección); el límite es ${num(limit)} ${u}, así que no lleva el octógono.` };
    }
    notice(`detection_limit_${nutrient}`, 'warning', `El informe solo indica que ${labelOf(nutrient)} es menor que ${num(v.value)} ${u}, que no basta para descartar el octógono «${LEGEND[key]}»; por eso no lo evaluamos.`);
    return { ...base, status: 'not_evaluated', value: v.value, reason: 'detection_limit', explanation: `${title}: menos de ${num(v.value)} ${u} ${basisText(basis)}; el límite es ${num(limit)} ${u}, no se puede asegurar que no lo supere.` };
  }
  if (v && isTrans) {
    if (v.qualifier === '=' && v.value > 0) {
      return { ...base, status: 'required', value: v.value, reason: 'measured', explanation: `${title}: ${num(v.value)} g ${basisText(basis)}; cualquier cantidad mayor que 0 lleva el aviso «${LEGEND[key]}».` };
    }
    const lim = v.qualifier === '<';
    return { ...base, status: 'not_required', value: v.value, reason: lim ? 'detection_limit' : 'measured', explanation: lim ? `${title}: menos de ${num(v.value)} g ${basisText(basis)} (límite de detección), así que no lleva el aviso.` : `${title}: 0 g ${basisText(basis)}, así que no lleva el aviso.` };
  }

  // Missing nutrient: try an upper bound from total fat / carbohydrate.
  const boundNutrient = BOUND_BY[nutrient];
  const bound = boundNutrient ? values.get(boundNutrient) : undefined;
  if (bound && threshold !== null) {
    notice(`not_measured_${nutrient}`, 'info', `El informe no mide ${labelOf(nutrient)}; solo sabemos que no supera ${labelOf(boundNutrient!)} (${num(bound.value)} g ${basisText(basis)}).`);
    if (bound.value < threshold) {
      return { ...base, status: 'not_required', value: bound.value, reason: 'bounded', explanation: `${title}: no se mide, pero no puede superar ${num(bound.value)} g ${basisText(basis)} (${labelOf(boundNutrient!)}); el límite es ${num(threshold)} g, así que no lleva el octógono.` };
    }
    unmeasured();
    return { ...base, status: 'not_evaluated', value: bound.value, reason: 'missing', explanation: `${title}: el informe no lo reporta y ${labelOf(boundNutrient!)} (${num(bound.value)} g ${basisText(basis)}) no basta para descartar el límite de ${num(threshold)} g.` };
  }
  unmeasured();
  return { ...base, status: 'not_evaluated', value: null, reason: 'missing', explanation: `${title}: el informe no lo reporta, por eso no evaluamos este octógono.` };
}

function failure(reports: ReadonlyArray<ParsedLabReport>): LabelAnalysisFailure {
  const issues = reports.flatMap((r) => r.issues.map((i) => ({ ...i, fileId: r.fileId })));
  const why = (r: ParsedLabReport) =>
    r.issues.length > 0
      ? r.issues.map((i) => i.message).join(' ')
      : r.kind === 'microbiological'
        ? 'es un análisis microbiológico y no trae nutrientes.'
        : 'no trae nutrientes (solo otros parámetros como pH y acidez).';
  const lines = reports.map((r) => `- ${label(r)}: ${why(r)}`);
  return {
    ok: false,
    message: ['No pudimos usar ningún informe para armar tu tabla nutricional.', ...lines].join('\n'),
    issues,
  };
}
