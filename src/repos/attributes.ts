/**
 * KAN-87: the shared "patch the typed attributes of a brand or product" step. The row is locked, the
 * validated patch is merged into the stored attributes, and the MERGED object is validated again with
 * `partial: false`, so an edit can never leave a required field empty. The name column follows
 * `business_name` / `product_name`.
 */
import { applyAttributePatch, entityName, validateAttributes, type AttributeLevel } from '../core/brand-catalog';
import type { TxClient } from '../db/with-transaction';

export interface AttributePatch {
  readonly values: Record<string, unknown>;
  readonly cleared: ReadonlyArray<string>;
}

export type AttributeUpdateResult =
  | { readonly ok: true; readonly name: string | null; readonly attributes: Record<string, unknown> }
  | { readonly ok: false; readonly code: 'not_found' }
  | { readonly ok: false; readonly code: 'invalid_input'; readonly errors: Record<string, string> };

const TABLE = { brand: 'brands', product: 'products' } as const;

export async function updateAttributesInTx(
  tx: TxClient,
  input: { level: AttributeLevel; id: string; tenantId: string; userId: string; patch: AttributePatch },
): Promise<AttributeUpdateResult> {
  const table = TABLE[input.level];
  // Products have no status: an archived brand's products stay read-only through the brand guard below.
  const guard = input.level === 'brand'
    ? `AND status = 'active'`
    : `AND EXISTS (SELECT 1 FROM brands b WHERE b.tenant_id = products.tenant_id AND b.id = products.brand_id AND b.status = 'active')`;
  const current = await tx.query<{ attributes: Record<string, unknown> }>(
    `SELECT attributes FROM ${table} WHERE id = $1 AND tenant_id = $2 AND user_id = $3 ${guard} FOR UPDATE`,
    [input.id, input.tenantId, input.userId],
  );
  if (!current.rows[0]) return { ok: false, code: 'not_found' };
  const merged = applyAttributePatch(current.rows[0].attributes, input.patch);
  const verdict = validateAttributes(input.level, merged, { partial: false });
  if (!verdict.ok) return { ok: false, code: 'invalid_input', errors: verdict.errors };
  const name = entityName(input.level, verdict.values);
  await tx.query(
    `UPDATE ${table} SET name = $4, attributes = $5::jsonb, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [input.id, input.tenantId, input.userId, name, JSON.stringify(verdict.values)],
  );
  return { ok: true, name, attributes: verdict.values };
}
