'use server';

import { requireGlobalMfa } from '../../src/auth/resolve-identity';
import { globalRepos } from '../../src/repos/global';
import {
  createWorkosOrganizationsClient,
  PlatformOrganizationAdminService,
  PlatformOrganizationService,
  type AdminProvisionResult,
  type WorkosOrganizationsClient,
} from '../../src/services/platform/organizations';
import { createWorkosAccountsClient, EMAIL_PATTERN, parseReason, type WorkosMember } from '../../src/services/tenant-accounts';
import { defaultTenantKeyService } from '../../src/services/openrouter/tenant-keys';
import { loggerFor } from '../../src/services/logger';
import { getPlatformMonthlyMetrics, getPlatformAuditTrail } from '../../src/services/platform/metrics/monthly';

const repositories = globalRepos();
const log = loggerFor('actions.platform-admin');

export async function getPlatformOrganizations() {
  await requireGlobalMfa();
  return repositories.organizations.list();
}

export async function getPlatformOrganization(tenantId: string) {
  await requireGlobalMfa();
  return repositories.organizations.getById(tenantId);
}

export async function getPlatformOperators() {
  await requireGlobalMfa();
  return repositories.identity.listSuperadmins();
}

export async function grantPlatformOperator(input: { workosUserId: string; reason: string }) {
  const identity = await requireGlobalMfa();
  const workosUserId = input.workosUserId.trim();
  const reason = input.reason.trim();
  validateOperatorInput(workosUserId, reason);
  await repositories.identity.grantSuperadmin(identity.workosUserId, workosUserId, reason);
}

export async function revokePlatformOperator(input: { workosUserId: string; reason: string }) {
  const identity = await requireGlobalMfa();
  const workosUserId = input.workosUserId.trim();
  const reason = input.reason.trim();
  validateOperatorInput(workosUserId, reason);
  return repositories.identity.revokeSuperadmin(identity.workosUserId, workosUserId, reason);
}

function validateOperatorInput(workosUserId: string, reason: string): void {
  if (!/^user_[A-Za-z0-9]+$/.test(workosUserId)) throw new Error('Escribe un ID de usuario de WorkOS válido.');
  if (!reason) throw new Error('Escribe el motivo.');
}

export interface CreateOrganizationResult {
  readonly tenantId: string;
  readonly workosOrgId: string;
  /** The organization exists even when `admin.ok` is false; retry from the organization detail. */
  readonly admin: AdminProvisionResult;
}

const organizationService = (workos: WorkosOrganizationsClient = createWorkosOrganizationsClient()) => new PlatformOrganizationService(workos);
const adminService = () => new PlatformOrganizationAdminService(createWorkosAccountsClient());

/** D52: creates the organization and provisions its first admin (WorkOS-only, role `admin`). */
export async function createPlatformOrganization(input: { operationKey: string; name: string; adminEmail: string; reason: string }): Promise<CreateOrganizationResult> {
  const identity = await requireGlobalMfa();
  const name = input.name.trim();
  const reason = input.reason.trim();
  const adminEmail = String(input.adminEmail ?? '').trim().toLowerCase();
  if (!name || !reason) throw new Error('Escribe el nombre de la organización y el motivo.');
  if (adminEmail.length > 254 || !EMAIL_PATTERN.test(adminEmail)) throw new Error('Escribe un correo electrónico válido para el administrador.');
  if (!input.operationKey.trim()) throw new Error('No se pudo iniciar la operación. Inténtalo de nuevo.');
  const created = await organizationService().create({ operationKey: input.operationKey, name, actorWorkosUserId: identity.workosUserId, reason });
  log.debug({ tenantId: created.tenantId }, 'organization.created');
  const admin = await adminService().provision({
    tenantId: created.tenantId, workosOrgId: created.workosOrgId, email: adminEmail, actorWorkosUserId: identity.workosUserId, reason,
  });
  return { ...created, admin };
}

/** D52: add (or retry) an organization admin from the organization detail. */
export async function provisionPlatformOrganizationAdmin(input: { tenantId: string; email: string; reason: string }): Promise<AdminProvisionResult> {
  const identity = await requireGlobalMfa();
  const reason = parseReason(input.reason)?.trim();
  if (!reason) return { ok: false, code: 'invalid_reason', message: 'Escribe el motivo (hasta 500 caracteres).' };
  const organization = await repositories.organizations.getById(input.tenantId);
  if (!organization?.workosOrgId) return { ok: false, code: 'failed', message: 'La organización no está vinculada todavía. Inténtalo más tarde.' };
  return adminService().provision({
    tenantId: organization.tenantId, workosOrgId: organization.workosOrgId, email: input.email, actorWorkosUserId: identity.workosUserId, reason,
  });
}

/** D52: active admin memberships of the organization, read from WorkOS. */
export async function getPlatformOrganizationAdmins(tenantId: string): Promise<ReadonlyArray<WorkosMember>> {
  await requireGlobalMfa();
  const organization = await repositories.organizations.getById(tenantId);
  return organization?.workosOrgId ? adminService().listAdmins(organization.workosOrgId) : [];
}

export async function renamePlatformOrganization(input: { tenantId: string; name: string; reason: string }) {
  const identity = await requireGlobalMfa();
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (!name || !reason) throw new Error('Escribe el nombre de la organización y el motivo.');
  await organizationService().rename({ ...input, name, reason, actorWorkosUserId: identity.workosUserId });
}

export async function setPlatformOrganizationActive(input: { tenantId: string; active: boolean; reason: string }) {
  const identity = await requireGlobalMfa();
  const reason = input.reason.trim();
  if (!reason) throw new Error('Escribe el motivo.');
  const changed = await repositories.organizations.setStatus({ tenantId: input.tenantId, status: input.active ? 'active' : 'inactive', actorWorkosUserId: identity.workosUserId, reason });
  // D36: a suspended tenant's OpenRouter sub-key stops spending; the ledger status is already authoritative.
  if (changed) {
    try { await defaultTenantKeyService()?.setEnabled(input.tenantId, input.active); }
    catch (err) { log.error({ tenantId: input.tenantId, err: err instanceof Error ? err.name : 'unknown' }, 'credits.key_toggle_failed'); }
  }
  return changed;
}

const MAX_RECHARGE_USD = 100_000;

export interface RechargeResult { readonly created: boolean; readonly balanceUsd: number; readonly keySynced: boolean }

/** F21/F24: record a recharge AFTER the tenant paid outside the platform (D36). Audited, idempotent per `operationKey`. */
export async function rechargeTenantCredits(input: { tenantId: string; operationKey: string; amountUsd: number; reference: string; reason: string }): Promise<RechargeResult> {
  const identity = await requireGlobalMfa();
  const reference = input.reference.trim();
  const reason = input.reason.trim();
  const amountUsd = Math.round(Number(input.amountUsd) * 1_000_000) / 1_000_000;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_RECHARGE_USD) throw new Error('Escribe un monto válido en USD.');
  if (!reference || !reason) throw new Error('Escribe la referencia del pago y el motivo.');
  if (!input.operationKey.trim()) throw new Error('No se pudo iniciar la operación. Inténtalo de nuevo.');
  const { created, balanceUsd } = await repositories.credits.recordEntry({
    tenantId: input.tenantId, kind: 'recharge', amountUsd, idempotencyKey: `recharge:${input.operationKey}`,
    externalRef: reference, reason, actorWorkosUserId: identity.workosUserId,
  });
  log.debug({ tenantId: input.tenantId, created }, 'credits.recharge');
  // The ledger is the truth; a failed sub-key sync is retried on the next settlement/recharge.
  let keySynced = false;
  try {
    const keys = defaultTenantKeyService();
    if (keys) { await keys.ensureKey(input.tenantId, identity.workosUserId); await keys.syncLimit(input.tenantId); keySynced = true; }
  } catch (err) {
    log.error({ tenantId: input.tenantId, err: err instanceof Error ? err.name : 'unknown' }, 'credits.key_sync_failed');
  }
  return { created, balanceUsd, keySynced };
}

export async function getMonthlyPlatformMetrics(month: string) {
  const identity = await requireGlobalMfa();
  return getPlatformMonthlyMetrics(identity.workosUserId, month);
}

export async function getPlatformAuditEvents() {
  const identity = await requireGlobalMfa();
  return getPlatformAuditTrail(identity.workosUserId);
}

export async function getTenantCreditsView(tenantId: string) {
  const identity = await requireGlobalMfa();
  const [balanceUsd, ledger] = await Promise.all([
    repositories.credits.balance(tenantId),
    repositories.credits.listLedger(identity.workosUserId, tenantId),
  ]);
  return { balanceUsd, ledger };
}

export async function getTenantReconciliation(tenantId: string) {
  const identity = await requireGlobalMfa();
  const keys = defaultTenantKeyService();
  if (!keys) return null;
  return keys.reconcile(identity.workosUserId, tenantId);
}
