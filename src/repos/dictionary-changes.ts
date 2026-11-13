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

export function dictionaryChangesRepo() {
  return {
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
