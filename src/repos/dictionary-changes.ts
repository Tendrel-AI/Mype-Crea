/**
 * D41 OTRO promotion, server side only (the `/platform` UI comes later). The caller must already have
 * passed the platform authorization and MFA checks (rules/auth.md); this re-checks the persisted
 * superadmin and applies the pure plan (`planPromotion`) to history in one global transaction.
 */
import { withGlobalTransaction } from '../db/global-transaction';
import { BRIEF_CATALOG } from '../core/brief';
import { dictionaryFor, planPromotion, type PromotionInput } from '../core/dictionaries';
import { loggerFor } from '../services/logger';
import { assertActivePlatformActor, insertGlobalAuditEvent } from './global-audit';

const log = loggerFor('repos.dictionary-changes');

export interface PromotionResult {
  readonly category: string;
  readonly rowsRemapped: number;
}

export interface OtroText { readonly dictionaryKey: string; readonly text: string; readonly count: number; readonly lastSeen: string }
export interface DictionaryChangeRow {
  readonly dictionaryKey: string; readonly version: string; readonly category: string;
  readonly label: string; readonly rowsRemapped: number; readonly appliedAt: string;
}

const fieldsOf = (dictionaryKey: string) => BRIEF_CATALOG.filter((f) => f.vocabulary === dictionaryKey).map((f) => f.name);

export function dictionaryChangesRepo() {
  return {
    /** Top `OTRO` raw texts across tenants for one dictionary (text, count, last seen only). */
    async otroTexts(actorWorkosUserId: string, dictionaryKey: string, top = 50): Promise<OtroText[]> {
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const res = await tx.query<{ raw_canonical: string; n: string; last_seen: Date }>(
          // Same canonical text can appear in several fields of one vocabulary: merge by text.
          `SELECT raw_canonical, sum(n)::text AS n, max(last_seen) AS last_seen
             FROM app.platform_otro_texts($1::text[], $2) GROUP BY raw_canonical ORDER BY sum(n) DESC, raw_canonical LIMIT $2`,
          [fieldsOf(dictionaryKey), top]);
        return res.rows.map((r) => ({ dictionaryKey, text: r.raw_canonical, count: Number(r.n), lastSeen: r.last_seen.toISOString() }));
      });
    },

    async history(): Promise<DictionaryChangeRow[]> {
      return withGlobalTransaction(async (tx) => {
        const res = await tx.query<{ dictionary_key: string; version: string; category: string; label: string; rows_remapped: number; applied_at: Date }>(
          'SELECT dictionary_key, version, category, label, rows_remapped, applied_at FROM dictionary_changes ORDER BY applied_at DESC LIMIT 100');
        return res.rows.map((r) => ({
          dictionaryKey: r.dictionary_key, version: r.version, category: r.category, label: r.label,
          rowsRemapped: r.rows_remapped, appliedAt: r.applied_at.toISOString(),
        }));
      });
    },

    /**
     * Applies a promotion. The new category must already be in the code dictionary (add the label and bump
     * its `version` first), so new rows and remapped history agree.
     */
    async promote(input: PromotionInput, actorWorkosUserId: string): Promise<PromotionResult> {
      const plan = planPromotion(input);
      const dict = dictionaryFor(plan.dictionaryKey)!;
      const fields = BRIEF_CATALOG.filter((f) => f.vocabulary === plan.dictionaryKey).map((f) => f.name);
      return withGlobalTransaction(async (tx) => {
        await assertActivePlatformActor(tx, actorWorkosUserId);
        const result = await tx.query<{ remapped: number }>(
          'SELECT app.apply_dictionary_promotion($1, $2, $3, $4, $5::text[], $6::text[]) AS remapped',
          [plan.dictionaryKey, dict.version, plan.category, plan.label, fields, plan.canonicalTexts],
        );
        const rowsRemapped = Number(result.rows[0].remapped);
        await insertGlobalAuditEvent(tx, {
          actorWorkosUserId, action: 'dictionary.promote', scopeType: 'dictionary', scopeId: plan.dictionaryKey,
          newVersion: dict.version, outcome: 'success', metadata: { category: plan.category, rowsRemapped },
        });
        log.info({ dictionaryKey: plan.dictionaryKey, category: plan.category, rowsRemapped }, 'dictionary.promoted');
        return { category: plan.category, rowsRemapped };
      });
    },
  };
}
