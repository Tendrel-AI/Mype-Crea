'use server';

import { getWorkOS } from '@workos-inc/authkit-nextjs';
import { requireGlobalMfa } from '../../src/auth/resolve-identity';
import { globalRepos } from '../../src/repos/global';
import { PlatformOrganizationService } from '../../src/services/platform/organizations';
import { getPlatformMonthlyMetrics, getPlatformAuditTrail } from '../../src/services/platform/metrics/monthly';

const repositories = globalRepos();

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

export async function createPlatformOrganization(input: { operationKey: string; name: string; reason: string }) {
  const identity = await requireGlobalMfa();
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (!name || !reason) throw new Error('Escribe el nombre de la organización y el motivo.');
  const workos = getWorkOS();
  const service = new PlatformOrganizationService({
    async findByExternalId(externalId) {
      const organizations = await workos.organizations.listOrganizations().then((result) => result.autoPagination());
      for (const organization of organizations) {
        if (organization.externalId === externalId) return { id: organization.id, externalId: organization.externalId };
      }
      return undefined;
    },
    async create(payload) {
      const organization = await workos.organizations.createOrganization(payload, { idempotencyKey: payload.externalId });
      return { id: organization.id, externalId: organization.externalId };
    },
    async update(payload) {
      const organization = await workos.organizations.updateOrganization({ organization: payload.id, name: payload.name });
      return { id: organization.id, externalId: organization.externalId };
    },
  });
  if (!input.operationKey.trim()) throw new Error('No se pudo iniciar la operación. Inténtalo de nuevo.');
  return service.create({ operationKey: input.operationKey, name, actorWorkosUserId: identity.workosUserId, reason });
}

export async function renamePlatformOrganization(input: { tenantId: string; name: string; reason: string }) {
  const identity = await requireGlobalMfa();
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (!name || !reason) throw new Error('Escribe el nombre de la organización y el motivo.');
  const workos = getWorkOS();
  const service = new PlatformOrganizationService({
    async findByExternalId() { return undefined; },
    async create() { throw new Error('No se pudo actualizar la organización.'); },
    async update(payload) {
      const organization = await workos.organizations.updateOrganization({ organization: payload.id, name: payload.name });
      return { id: organization.id, externalId: organization.externalId };
    },
  });
  await service.rename({ ...input, name, reason, actorWorkosUserId: identity.workosUserId });
}

export async function setPlatformOrganizationActive(input: { tenantId: string; active: boolean; reason: string }) {
  const identity = await requireGlobalMfa();
  const reason = input.reason.trim();
  if (!reason) throw new Error('Escribe el motivo.');
  return repositories.organizations.setStatus({ tenantId: input.tenantId, status: input.active ? 'active' : 'inactive', actorWorkosUserId: identity.workosUserId, reason });
}

export async function getMonthlyPlatformMetrics(month: string) {
  const identity = await requireGlobalMfa();
  return getPlatformMonthlyMetrics(identity.workosUserId, month);
}

export async function getPlatformAuditEvents() {
  const identity = await requireGlobalMfa();
  return getPlatformAuditTrail(identity.workosUserId);
}
