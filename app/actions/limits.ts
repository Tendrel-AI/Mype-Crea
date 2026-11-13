'use server';

/**
 * D38 / D39 controllers: the tenant admin's `/admin/limits` (default profile values + audit) and the
 * remaining-counts read the deliverable cards and the planner use. Tenant, actor and role come only
 * from the live identity; the DB re-checks the admin role and the 0..1000 range.
 */
import { unstable_rethrow } from 'next/navigation';
import { requireTenantAdmin, TenantAdminRequiredError, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { NotTenantAdminError } from '../../src/repos/tenant-accounts';
import type { LimitAuditRow } from '../../src/repos/limits';
import type { ConversationId, UUID } from '../../src/core/contracts';
import { getLimitCatalog, getLimitGate } from '../../src/core/limits/runtime';
import { isValidLimitValue, LIMIT_MAX, LIMIT_MIN, withDefaults, type LimitKeyDef } from '../../src/core/limits/catalog';
import type { RemainingCounts } from '../../src/core/limits/gate';
import { loggerFor } from '../../src/services/logger';
import { authorizeConversation, isUuid } from './conversation-access';

const log = loggerFor('actions.limits');

const NOT_ADMIN = { ok: false, code: 'not_admin', message: 'No tienes permiso para cambiar los límites de esta organización.' } as const;
const FAILED = { ok: false, code: 'failed', message: 'No pudimos completar la acción. Vuelve a intentarlo.' } as const;
type Refused = typeof NOT_ADMIN | typeof FAILED;

export interface LimitsAdminView {
  readonly ok: true;
  readonly profileId: UUID;
  readonly profileName: string;
  readonly keys: ReadonlyArray<LimitKeyDef & { readonly value: number }>;
  readonly audit: ReadonlyArray<LimitAuditRow>;
}

async function asAdmin<T>(operation: string, work: (identity: ResolvedIdentity) => Promise<T>): Promise<T | Refused> {
  let identity: ResolvedIdentity;
  try {
    identity = await requireTenantAdmin();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TenantAdminRequiredError) {
      log.warn({ operation, tenantId: error.identity.tenant.id, userId: error.identity.user.id }, 'limits.refused_not_admin');
      return NOT_ADMIN;
    }
    return FAILED;
  }
  try {
    return await work(identity);
  } catch (error) {
    if (error instanceof NotTenantAdminError) return NOT_ADMIN;
    log.error({ operation, tenantId: identity.tenant.id, err: error instanceof Error ? error.name : 'unknown' }, 'limits.failed');
    return FAILED;
  }
}

export async function getLimitsAdminView(): Promise<LimitsAdminView | Refused> {
  return asAdmin('view', async (identity) => {
    const profile = await repos(identity.tenant, identity.user).limits.getDefaultProfile();
    if (!profile) return FAILED;
    const catalog = getLimitCatalog();
    const values = withDefaults(catalog, profile.values);
    return {
      ok: true as const,
      profileId: profile.profileId,
      profileName: profile.name,
      keys: catalog.map((def) => ({ ...def, value: values[def.key] })),
      audit: profile.audit,
    };
  });
}

export type UpdateLimitResult = { readonly ok: true } | Refused | { readonly ok: false; readonly code: 'invalid_input'; readonly message: string };

export async function updateLimitValueAction(input: {
  readonly profileId: string;
  readonly limitKey: string;
  readonly value: number;
  readonly reason?: string;
}): Promise<UpdateLimitResult> {
  const key = typeof input?.limitKey === 'string' ? input.limitKey : '';
  const reason = typeof input?.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (!isUuid(input?.profileId) || !getLimitCatalog().some((def) => def.key === key) || !isValidLimitValue(input?.value)) {
    return { ok: false, code: 'invalid_input', message: `Los límites deben ser números enteros entre ${LIMIT_MIN} y ${LIMIT_MAX}.` };
  }
  return asAdmin('update', async (identity) => {
    await repos(identity.tenant, identity.user).limits.setValue({
      profileId: input.profileId as UUID, limitKey: key, value: input.value, reason: reason || null,
    });
    return { ok: true as const };
  });
}

export type RemainingCountsResult =
  | { readonly ok: true; readonly counts: RemainingCounts }
  | { readonly ok: false; readonly message: string };

/** Remaining alterations per deliverable kind and remaining turns of one owned conversation (D39 cards / planner state). */
export async function getRemainingCountsAction(input: { readonly conversationId: string }): Promise<RemainingCountsResult> {
  if (!isUuid(input?.conversationId)) return { ok: false, message: FAILED.message };
  const authorized = await authorizeConversation(input.conversationId as ConversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return { ok: false, message: authorized.message };
  try {
    const { tenant, user } = authorized.identity;
    return { ok: true, counts: await getLimitGate(tenant, user).remaining(input.conversationId as ConversationId) };
  } catch (error) {
    log.error({ err: error }, 'limits.remaining_failed');
    return { ok: false, message: FAILED.message };
  }
}
