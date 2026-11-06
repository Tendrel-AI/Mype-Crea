'use server';

import { requireGlobalMfa } from '../../src/auth/resolve-identity';
import { listPlatformModules, platformModuleRolloutService } from '../../src/services/platform/rollout';
import type { RolloutScope } from '../../src/services/platform/rollout/service';

export async function listPlatformModulesAction() {
  await requireGlobalMfa();
  return listPlatformModules().map(({ validateConfig: _validate, ...module }) => module);
}

export async function publishPlatformModuleVersion(input: { moduleId: string; config: unknown }) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).publishVersion({ ...input, actorWorkosUserId: identity.workosUserId });
}

export async function publishAiModuleVersion(input: {
  name: string;
  manifest: unknown;
  allowedOverridePaths: readonly string[];
  operationKey: string;
  reason?: string;
}) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).publishAiModuleVersion({
    ...input,
    actorWorkosUserId: identity.workosUserId,
  });
}

export async function listPlatformModuleVersions(moduleId: string) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).listVersions({ actorWorkosUserId: identity.workosUserId, moduleId });
}

export async function getPlatformModuleOperation(operationKey: string) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).getOperation({ actorWorkosUserId: identity.workosUserId, operationKey });
}

export async function listOrganizationModuleRolloutHistory(organizationId: string) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).listOperationsForOrganization({
    actorWorkosUserId: identity.workosUserId,
    organizationId,
  });
}

export async function getOrganizationEffectiveModuleVersion(input: { moduleId: string; organizationId: string }) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).getEffectiveVersion({
    ...input,
    actorWorkosUserId: identity.workosUserId,
  });
}

export async function previewPlatformModuleRollout(input: { moduleId: string; version: number; scope: RolloutScope }) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).preview({ ...input, actorWorkosUserId: identity.workosUserId });
}

export async function applyPlatformModuleRollout(input: { moduleId: string; version: number; scope: RolloutScope; operationKey: string; reason?: string }) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).apply({ ...input, actorWorkosUserId: identity.workosUserId });
}

export async function retryPlatformModuleRollout(input: { operationKey: string; reason?: string }) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).retry({ ...input, actorWorkosUserId: identity.workosUserId });
}

export async function rollbackPlatformModule(input: { moduleId: string; targetVersion: number; scope: RolloutScope; operationKey: string; reason: string }) {
  const identity = await requireGlobalMfa();
  return platformModuleRolloutService(identity.workosUserId).rollback({ ...input, actorWorkosUserId: identity.workosUserId });
}
