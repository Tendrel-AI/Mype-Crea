/**
 * KAN-89: a brand created with «Ya tengo una marca» already has its identity. Its name, its current
 * tagline and its uploaded logo become the brand's approved Nombre, Lema and Logo, through the SAME
 * path as «Usar mi nombre / lema / logo» (`OrchestratorCoreImpl.adoptOwnVersion`). Server-only; the
 * caller authenticated the owner. Never throws: a failure is logged and the brand stays as created.
 */
import type { ResolvedIdentity } from '../auth/resolve-identity';
import { IMPORTED_KEY, NAME_PENDING_KEY } from '../core/brand-catalog';
import type { ConversationId, UUID } from '../core/contracts';
import { getOrchestrator } from '../core/orchestrator/runtime';
import { repos } from '../repos';
import { loggerFor } from '../services/logger';

const log = loggerFor('conversations.imported-identity');

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

async function adopt(
  identity: ResolvedIdentity,
  conversationId: ConversationId,
  items: ReadonlyArray<readonly [kind: string, text?: string]>,
): Promise<void> {
  const core = getOrchestrator();
  await core.startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);
  for (const [kind, value] of items) {
    try {
      const stored = await core.adoptOwnVersion(conversationId, kind, value);
      log.debug({ conversationId, kind, stored }, 'imported_identity.adopted');
    } catch (err) {
      log.error({ conversationId, kind, err }, 'imported_identity.failed');
    }
  }
}

/** On creation: the name (unless «Aún no tengo nombre») and the current tagline of the form. */
export async function adoptImportedBrand(
  identity: ResolvedIdentity,
  conversationId: ConversationId,
  attributes: Readonly<Record<string, unknown>>,
): Promise<void> {
  const name = attributes[NAME_PENDING_KEY] === true ? undefined : text(attributes.business_name);
  const tagline = text(attributes.existing_tagline);
  try {
    await adopt(identity, conversationId, [
      ...(name ? [['business_name', name] as const] : []),
      ...(tagline ? [['tagline', tagline] as const] : []),
    ]);
  } catch (err) {
    log.error({ conversationId, err }, 'imported_identity.start_failed');
  }
}

/** On a logo upload of an imported brand: the new upload becomes the approved logo. */
export async function adoptImportedLogo(
  identity: ResolvedIdentity,
  brand: { readonly id: UUID; readonly attributes: Readonly<Record<string, unknown>> },
): Promise<void> {
  try {
    if (brand.attributes[IMPORTED_KEY] !== true) return;
    const conversationId = await repos(identity.tenant, identity.user).ownCandidates.findBrandConversation(brand.id);
    if (conversationId) await adopt(identity, conversationId, [['logo']]);
  } catch (err) {
    log.error({ brandId: brand.id, err }, 'imported_identity.logo_failed');
  }
}
