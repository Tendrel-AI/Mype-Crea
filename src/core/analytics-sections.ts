/**
 * D41 / F23: one analytics section per catalog field, derived from the catalog (never a hand-written
 * field list), so a new, changed or deprecated field shows up without touching the panel.
 * Pure: the page renders what this returns.
 */
import type { BriefFieldSpec } from './brief';
import { dictionaryFor } from './dictionaries';

export interface AnalyticsFieldData {
  readonly name: string;
  readonly filledConversations: number;
  readonly values: ReadonlyArray<{ readonly value: string; readonly count: number }>;
}

export interface AnalyticsSection {
  readonly name: string;
  readonly label: string;
  readonly analytics: 'category' | 'tags' | 'text';
  readonly filledConversations: number;
  /** Share of the org's conversations that have the field, 0..100 (integer). */
  readonly fillRate: number;
  /** Counts per canonical value; empty for `text` fields (fill rate only). Labels come from the dictionary. */
  readonly values: ReadonlyArray<{ readonly value: string; readonly label: string; readonly count: number }>;
  readonly dictionaryVersion?: string;
  /** `YYYY-MM-DD` when the field is deprecated: rendered as «Retirado desde <fecha>». */
  readonly deprecatedSince?: string;
}

export function buildAnalyticsSections(
  catalog: ReadonlyArray<BriefFieldSpec>,
  fields: ReadonlyArray<AnalyticsFieldData>,
  conversations: number,
): ReadonlyArray<AnalyticsSection> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return catalog.flatMap((spec) => {
    if (spec.analytics === 'none') return [];
    const data = byName.get(spec.name);
    const dict = spec.vocabulary ? dictionaryFor(spec.vocabulary) : undefined;
    const labels = new Map(dict?.entries.map((e) => [e.code, e.label]));
    const filled = data?.filledConversations ?? 0;
    return [{
      name: spec.name,
      label: spec.label,
      analytics: spec.analytics,
      filledConversations: filled,
      fillRate: conversations > 0 ? Math.round((filled / conversations) * 100) : 0,
      values: spec.analytics === 'text' ? [] : (data?.values ?? []).map((v) => ({ ...v, label: labels.get(v.value) ?? v.value })),
      ...(dict ? { dictionaryVersion: dict.version } : {}),
      ...(spec.deprecatedSince ? { deprecatedSince: spec.deprecatedSince } : {}),
    }];
  });
}
