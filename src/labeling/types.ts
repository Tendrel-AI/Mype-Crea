/**
 * Shared contract for the nutrition label deliverable (D32): lab report PDF -> nutrition table + octagons.
 * Pure types, no imports. Owned by the orchestrator: feature branches copy this file byte for byte and never
 * edit it; a needed change is reported back instead.
 *
 * Implementations (one per branch):
 *  - src/labeling/lab-report-parser.ts  parseLabReportPdf(bytes: Uint8Array, fileId: string): Promise<ParsedLabReport>  (never throws)
 *  - src/labeling/analyze.ts            analyzeLabReports(reports: ReadonlyArray<ParsedLabReport>, options?: AnalyzeOptions): LabelResult | LabelAnalysisFailure  (pure)
 *  - src/labeling/octagon-svg.ts        octagonSvg(key: OctagonKey): string  (pure)
 */

/** Canonical units: g, except sodium and cholesterol (mg) and energy_kcal (kcal). */
export type Nutrient =
  | 'energy_kcal'
  | 'protein'
  | 'total_fat'
  | 'saturated_fat'
  | 'trans_fat'
  | 'carbohydrate'
  | 'total_sugars'
  | 'fiber'
  | 'sodium'
  | 'cholesterol';

export type Basis = 'per_100g' | 'per_100ml';

export interface Measurement {
  readonly nutrient: Nutrient;
  /** In the canonical unit. With qualifier '<' it is the detection limit. */
  readonly value: number;
  readonly qualifier: '=' | '<';
  readonly basis: Basis;
  /** The row as printed, for traceability and user-facing messages. */
  readonly source: { readonly parameter: string; readonly result: string; readonly unit: string; readonly page: number };
}

export type ReportKind = 'nutritional' | 'other_physicochemical' | 'microbiological' | 'unknown';

export type ParseIssueCode =
  | 'unreadable_pdf'
  | 'encrypted_pdf'
  | 'no_text_layer'
  | 'no_results_table'
  | 'unknown_parameter'
  | 'unparsed_value'
  | 'unknown_unit'
  | 'duplicate_parameter';

export interface ParseIssue {
  readonly code: ParseIssueCode;
  /** Neutral Latin-American Spanish, tuteo; shown to the user as is. */
  readonly message: string;
  /** Raw text involved, if any. */
  readonly detail?: string;
}

export interface ParsedLabReport {
  readonly fileId: string;
  readonly reportNumber: string | null;
  readonly laboratory: string | null;
  /** ISO date YYYY-MM-DD. */
  readonly issuedAt: string | null;
  readonly sample: {
    readonly description: string | null;
    readonly lot: string | null;
    readonly declaredContent: { readonly amount: number; readonly unit: 'ml' | 'l' | 'g' | 'kg' } | null;
    readonly state: 'liquid' | 'solid' | null;
    readonly densityGPerMl: number | null;
  };
  readonly kind: ReportKind;
  readonly measurements: ReadonlyArray<Measurement>;
  /** Recognized non-nutrient parameters (pH, acidez, Brix, microbiology...), listed for transparency. */
  readonly otherParameters: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<ParseIssue>;
}

export type OctagonKey = 'alto_en_sodio' | 'alto_en_azucar' | 'alto_en_grasas_saturadas' | 'contiene_grasas_trans';

export interface OctagonVerdict {
  readonly key: OctagonKey;
  /** required: show it. not_required: proven below threshold. not_evaluated: data missing; not shown, explained in a notice. */
  readonly status: 'required' | 'not_required' | 'not_evaluated';
  readonly nutrient: Nutrient;
  /** Value on `basis` used for the decision (an upper bound when reason is 'bounded' or 'detection_limit'). */
  readonly value: number | null;
  readonly threshold: number | null;
  readonly basis: Basis;
  readonly reason: 'measured' | 'bounded' | 'detection_limit' | 'missing';
  /** One Spanish sentence. */
  readonly explanation: string;
}

export interface NutritionRow {
  readonly nutrient: Nutrient;
  /** Spanish, e.g. «Grasa saturada». */
  readonly label: string;
  readonly unit: 'kcal' | 'g' | 'mg';
  /** Rounded and formatted with decimal comma, e.g. "5,6" or "<0,1"; null = not reported. */
  readonly per100: string | null;
  readonly perServing: string | null;
}

export interface LabelNotice {
  readonly code: string;
  readonly severity: 'info' | 'warning';
  /** Spanish, tuteo. */
  readonly message: string;
}

export interface AnalyzeOptions {
  /** Overrides the declared content of the reports as the serving. */
  readonly serving?: { readonly amount: number; readonly unit: 'ml' | 'g' };
}

export interface LabelResult {
  readonly ok: true;
  readonly rulesVersion: string;
  readonly productState: 'liquid' | 'solid';
  /** Basis of the table and of the octagon decision. */
  readonly basis: Basis;
  readonly serving: { readonly amount: number; readonly unit: 'ml' | 'g' } | null;
  readonly table: ReadonlyArray<NutritionRow>;
  /** Always the four keys, in OctagonKey order. */
  readonly octagons: ReadonlyArray<OctagonVerdict>;
  readonly notices: ReadonlyArray<LabelNotice>;
  readonly sources: ReadonlyArray<{ readonly fileId: string; readonly reportNumber: string | null; readonly used: boolean }>;
}

export interface LabelAnalysisFailure {
  readonly ok: false;
  /** Spanish, tuteo: why nothing usable was found. */
  readonly message: string;
  readonly issues: ReadonlyArray<ParseIssue & { readonly fileId: string }>;
}
