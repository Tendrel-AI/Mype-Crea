/**
 * D32 (nutrition label): the pure shapes shared by the command side and the label-agent handler: the
 * `requirements_snapshot` keys and the lab-report reference recorded there (no I/O, no DB).
 */
import type { AnalyzeOptions } from './types';

export const LABEL_AGENT_ID = 'label-agent';
/** `requirements_snapshot` keys the label-agent reads. */
export const LAB_REPORTS_KEY = 'lab_reports';
export const LAB_SERVING_KEY = 'lab_serving';

/** Shown when a label command has no lab report to work from (command preflight and handler). */
export const NO_LAB_REPORTS_MESSAGE = 'Sube primero el análisis de laboratorio de tu producto (PDF).';

/** One lab report as recorded in the task snapshot. */
export interface LabReportRef {
  readonly fileId: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly originalName: string;
}

/** «Botella 500 ml» -> 500 ml. Only ml and g count as a serving (KAN-90); anything else is null. */
export function servingFromPresentation(label: string | undefined | null): AnalyzeOptions['serving'] | null {
  const match = /(\d+(?:[.,]\d+)?)\s*(ml|g)\b/i.exec(label ?? '');
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  return amount > 0 ? { amount, unit: match[2].toLowerCase() as 'ml' | 'g' } : null;
}
