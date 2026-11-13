/**
 * D41 brief facts writer. Called from `conversations.updateFieldSlot`, the single place a merged value is
 * persisted, inside the same transaction. The normalization itself is pure (`src/core/brief-facts.ts`);
 * this only resolves brand/product from the conversation row and inserts, skipping a value identical to
 * the latest fact (the same value is fanned out to every agent that owns the field).
 */
import type { ConversationId, FieldSlot } from '../core/contracts';
import { BRIEF_CATALOG_VERSION } from '../core/brief';
import { factForField } from '../core/brief-facts';
import { loggerFor } from '../services/logger';
import type { Tenant, TxClient } from '../db/with-transaction';

const log = loggerFor('repos.brief-facts');

export async function recordBriefFact(
  tx: TxClient,
  tenant: Tenant,
  conversationId: ConversationId,
  fieldName: string,
  slot: FieldSlot,
): Promise<void> {
  // Pending values are not facts yet: the confirmation re-enters through the same chokepoint as `filled`.
  if (slot.status !== 'filled') return;
  const fact = factForField(fieldName, slot.value, slot.category);
  if (!fact) return;
  const result = await tx.query(
    `INSERT INTO brief_field_facts
       (tenant_id, user_id, brand_id, product_id, conversation_id, field_name, raw_value, raw_canonical,
        canonical_value, dictionary_version, catalog_version)
     SELECT c.tenant_id, c.user_id, c.brand_id, c.product_id, c.id, $3, $4, $5, $6, $7, $8
       FROM conversations c
      WHERE c.id = $1 AND c.tenant_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT raw_value, canonical_value FROM brief_field_facts
                          WHERE tenant_id = $2 AND conversation_id = $1 AND field_name = $3
                          ORDER BY recorded_at DESC, id DESC LIMIT 1) last
           WHERE last.raw_value = $4 AND last.canonical_value = $6)`,
    [conversationId, tenant.id, fact.fieldName, fact.rawValue, fact.rawCanonical, fact.canonicalValue,
      fact.dictionaryVersion, BRIEF_CATALOG_VERSION],
  );
  log.debug({ tenantId: tenant.id, conversationId, fieldName, canonical: fact.canonicalValue, inserted: result.rowCount }, 'brief_fact.recorded');
}
