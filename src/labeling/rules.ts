import type { Basis, Nutrient, OctagonKey } from './types';

/**
 * Regulatory constants for the label engine. Pure data, no logic.
 * Sources: KAN-50 spec R-THR-01..06 (phase 2 thresholds, >= semantics, PA-01), R-UNIT-01/02 (bases),
 * R-THR-07 (trans fat: no numeric threshold, any measured amount > 0); nutrition-table-spec R-NUT-14/15
 * (liquid/solid, density conversion) and the Codex CXG 2-1985 energy factors (provisional: NTP 209.652:2025 unread).
 */
export const RULES_VERSION = 'pe-octogonos-2021+codex-cxg2-provisional.1';

export const THRESHOLDS: Record<'sodium' | 'total_sugars' | 'saturated_fat', Record<Basis, number>> = {
  sodium: { per_100g: 400, per_100ml: 100 }, // R-THR-01 / R-THR-02 (mg)
  total_sugars: { per_100g: 10, per_100ml: 5 }, // R-THR-03 / R-THR-04 (g)
  saturated_fat: { per_100g: 4, per_100ml: 3 }, // R-THR-05 / R-THR-06 (g)
};

/** Codex energy factors, kcal per g. */
export const ENERGY_FACTORS = { protein: 4, total_fat: 9, carbohydrate: 4 } as const;
/** Relative difference between computed and lab energy that triggers an info notice. */
export const ENERGY_MISMATCH = 0.05;

export const OCTAGON_KEYS: ReadonlyArray<OctagonKey> = [
  'alto_en_sodio',
  'alto_en_azucar',
  'alto_en_grasas_saturadas',
  'contiene_grasas_trans',
];

export const TABLE_ROWS: ReadonlyArray<{ nutrient: Nutrient; label: string; unit: 'kcal' | 'g' | 'mg'; optional?: true }> = [
  { nutrient: 'energy_kcal', label: 'Energía', unit: 'kcal' },
  { nutrient: 'protein', label: 'Proteína', unit: 'g' },
  { nutrient: 'total_fat', label: 'Grasa total', unit: 'g' },
  { nutrient: 'saturated_fat', label: 'Grasa saturada', unit: 'g' },
  { nutrient: 'trans_fat', label: 'Grasa trans', unit: 'g' },
  { nutrient: 'carbohydrate', label: 'Carbohidratos', unit: 'g' },
  { nutrient: 'total_sugars', label: 'Azúcares totales', unit: 'g' },
  { nutrient: 'sodium', label: 'Sodio', unit: 'mg' },
  { nutrient: 'fiber', label: 'Fibra', unit: 'g', optional: true },
];
