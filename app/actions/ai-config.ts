'use server';

import { MfaRequiredError } from '../../src/auth/platform-mfa';
import { repositoryActor, requirePlatformStepUp, resolveIdentity, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { AiAdminService } from '../../src/services/ai-config/admin-service';
import { AiConfigService } from '../../src/services/ai-config/service';
import { ProviderRegistry } from '../../src/services/ai-config/provider-registry';

/** Typed failure reasons the page can act on. Everything else stays a generic failure. */
export type AiAdminFailureReason = 'mfa_required';

export interface AiAdminActionResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly reason?: AiAdminFailureReason;
}

const GENERIC_ERROR = 'No se pudo completar la acción de administración. Verifica tu acceso y vuelve a intentarlo.';
const MFA_REQUIRED_ERROR = 'Verifica tu código de autenticación de la plataforma para continuar.';

function configService(identity: ResolvedIdentity): AiConfigService {
  return new AiConfigService(() => repos(identity.tenant, identity.user, repositoryActor(identity)).aiConfig);
}

function adminService(identity: ResolvedIdentity): AiAdminService {
  return new AiAdminService(() => repos(identity.tenant, identity.user, repositoryActor(identity)).aiTurns);
}

async function action<T>(work: (identity: ResolvedIdentity) => Promise<T>): Promise<AiAdminActionResult<T>> {
  try {
    const identity = await resolveIdentity();
    try {
      // A real platform admin needs the step-up even while acting with reduced roles (KAN-79).
      await requirePlatformStepUp(identity);
    } catch (error) {
      // Only an effective platform admin is sent to /platform/mfa; a reduced identity is not
      // treated as one and keeps the generic failure (KAN-79).
      if (identity.platformAdmin && error instanceof MfaRequiredError) {
        return { ok: false, error: MFA_REQUIRED_ERROR, reason: 'mfa_required' };
      }
      throw error;
    }
    const data = await work(identity);
    return { ok: true, data: JSON.parse(JSON.stringify(data)) as T };
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
}

function requiredId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Identificador no válido.');
  }
  return value;
}

export async function getAiConfigAdminData() {
  return action(async (identity) => {
    const config = configService(identity);
    const admin = adminService(identity);
    const [releases, sharedReleases, activation, providers, syncEvents, usage, turns] = await Promise.all([
      config.listReleases(identity),
      config.listSharedReleases(identity),
      repos(identity.tenant, identity.user, repositoryActor(identity)).aiConfig.getActivation(),
      identity.tenantRole === 'admin' ? config.listProviderAvailability(identity) : Promise.resolve([]),
      identity.tenantRole === 'admin' || identity.platformAdmin ? config.listSyncEvents(identity) : Promise.resolve([]),
      identity.tenantRole === 'admin' ? admin.getUsage(identity) : Promise.resolve(null),
      identity.tenantRole === 'admin' ? admin.listTurns(identity, { limit: 100 }) : Promise.resolve([]),
    ]);
    const providerStatus = ['openrouter', 'anthropic'].map((provider) => ({
      provider,
      available: new ProviderRegistry().isPlatformAvailable(provider as 'openrouter' | 'anthropic'),
    }));
    return { tenantId: identity.tenant.id, organizationId: identity.organizationId, tenantRole: identity.tenantRole, platformAdmin: identity.platformAdmin, releases, sharedReleases, activation, providers, providerStatus, syncEvents, usage, turns };
  });
}

export async function createAiConfigDraft(input: { name: string; manifest: unknown; baseSharedReleaseId?: string }) {
  return action(async (identity) => {
    const service = configService(identity);
    if (!input.baseSharedReleaseId) return service.createDraft(identity, input);
    const draft = await service.createOverrideDraft(identity, { name: input.name, sharedReleaseId: requiredId(input.baseSharedReleaseId) });
    return service.updateDraft(identity, { releaseId: draft.id, expectedVersion: draft.draftVersion, manifest: input.manifest });
  });
}

export async function createSharedAiBaseline(name: string) {
  return action((identity) => configService(identity).createSharedBaselineDraft(identity, name));
}

export async function createSharedAiDraft(input: { name: string; manifest: unknown; allowedOverridePaths: readonly string[] }) {
  return action((identity) => configService(identity).createSharedDraft(identity, input));
}

export async function updateSharedAiDraft(input: { releaseId: string; expectedVersion: number; name?: string; manifest: unknown; allowedOverridePaths?: readonly string[] }) {
  return action((identity) => configService(identity).updateSharedDraft(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function updateAiConfigDraft(input: { releaseId: string; expectedVersion: number; name?: string; manifest: unknown }) {
  return action((identity) => configService(identity).updateDraft(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function importAiConfigDraft(input: { name: string; serialized: string; baseSharedReleaseId?: string }) {
  return action((identity) => configService(identity).importDraft(identity, { ...input, baseSharedReleaseId: input.baseSharedReleaseId ? requiredId(input.baseSharedReleaseId) : undefined }));
}

export async function validateAiConfigDraft(releaseId: string) {
  return action((identity) => configService(identity).validateDraft(identity, requiredId(releaseId)));
}

export async function diffAiConfigDraft(releaseId: string) {
  return action((identity) => configService(identity).diffDraft(identity, requiredId(releaseId)));
}

export async function validateSharedAiDraft(releaseId: string) {
  return action((identity) => configService(identity).validateSharedDraft(identity, requiredId(releaseId)));
}

export async function diffSharedAiDraft(input: { releaseId: string; manifest: unknown }) {
  return action((identity) => configService(identity).diffSharedDraft(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function freezeAiConfigDraft(input: { releaseId: string; expectedVersion: number }) {
  return action((identity) => configService(identity).freezeDraft(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function freezeSharedAiDraft(input: { releaseId: string; expectedVersion: number }) {
  return action((identity) => configService(identity).freezeSharedDraft(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function retireSharedAiRelease(input: { releaseId: string; expectedVersion: number }) {
  return action((identity) => configService(identity).retireSharedRelease(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function activateAiConfigRelease(input: { releaseId: string; expectedActivationVersion: number }) {
  return action((identity) => configService(identity).activate(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function activateSharedAiRelease(input: { sharedReleaseId: string; expectedSharedVersion: number; expectedActivationVersion: number }) {
  return action((identity) => configService(identity).activateShared(identity, { ...input, sharedReleaseId: requiredId(input.sharedReleaseId) }));
}

export async function retireAiConfigRelease(input: { releaseId: string; expectedVersion: number }) {
  return action((identity) => configService(identity).retireRelease(identity, { ...input, releaseId: requiredId(input.releaseId) }));
}

export async function setAiProviderAvailability(input: { provider: 'openrouter' | 'anthropic'; enabled: boolean; expectedVersion: number }) {
  return action((identity) => configService(identity).setProviderAvailability(identity, input));
}

export async function exportAiConfigRelease(releaseId: string) {
  return action((identity) => configService(identity).exportRelease(identity, requiredId(releaseId)));
}

export async function exportSharedAiConfigRelease(releaseId: string) {
  return action((identity) => configService(identity).exportSharedRelease(identity, requiredId(releaseId)));
}

export async function listAiSyncEvents(limit?: number) {
  return action((identity) => configService(identity).listSyncEvents(identity, limit));
}

export async function getAiTurnTrace(turnId: string) {
  return action((identity) => adminService(identity).getTurnTrace(identity, requiredId(turnId)));
}

export async function exportAiTurnTrace(turnId: string) {
  return action((identity) => adminService(identity).exportTurnTrace(identity, requiredId(turnId)));
}

export async function deleteAiTurnTraceContent(turnId: string) {
  return action((identity) => adminService(identity).deleteTraceContent(identity, requiredId(turnId)));
}
