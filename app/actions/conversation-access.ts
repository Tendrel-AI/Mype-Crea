/**
 * Owner-scoped conversation access shared by the panel controllers
 * (deliverable commands, KAN-28; brief panel, KAN-26). Not a server action
 * module: only server actions import it, so it is never callable directly.
 */

import { resolveIdentity, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { buildDefaultRegistry } from '../../src/core/orchestrator/bootstrap-registry';
import { getOrchestrator } from '../../src/core/orchestrator/runtime';
import type { ConversationId, UUID } from '../../src/core/contracts';
import { loggerFor } from '../../src/services/logger';
import { checkCurrentTerms } from '../../src/consent/gate';
import { TERMS_REQUIRED_MESSAGE, TERMS_UNAVAILABLE_MESSAGE } from '../../src/consent/terms';

const log = loggerFor('controller.conversation-access');

export type AccessFailureCode =
  | 'identity_unavailable'
  | 'durability_unavailable'
  | 'conversation_unavailable'
  | 'legacy_unversioned'
  | 'terms_required'
  | 'terms_unavailable';

const MESSAGES = {
  identity: 'No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.',
  durability: 'El servicio de tareas duraderas no está disponible. Inténtalo más tarde.',
  notFound: 'No encontramos esta conversación.',
  legacy: 'Esta conversación usa una configuración anterior. Inicia una conversación nueva para continuar.',
} as const;

export type Authorized = { readonly ok: true; readonly identity: ResolvedIdentity };
export type Unauthorized = { readonly ok: false; readonly code: AccessFailureCode; readonly message: string };

/** Owner-scoped, pinned conversation; registers its owner with the core. */
export async function authorizeConversation(
  conversationId: ConversationId,
  options: { readonly requireDurability: boolean; readonly requireTerms: boolean },
): Promise<Authorized | Unauthorized> {
  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity();
  } catch {
    return { ok: false, code: 'identity_unavailable', message: MESSAGES.identity };
  }
  if (options.requireTerms) {
    const terms = await checkCurrentTerms(identity);
    if (terms === 'required') return { ok: false, code: 'terms_required', message: TERMS_REQUIRED_MESSAGE };
    if (terms !== 'accepted') return { ok: false, code: 'terms_unavailable', message: TERMS_UNAVAILABLE_MESSAGE };
  }
  if (options.requireDurability && process.env.NODE_ENV !== 'test' && !process.env.REDIS_URL) {
    return { ok: false, code: 'durability_unavailable', message: MESSAGES.durability };
  }
  try {
    const registry = buildDefaultRegistry();
    const pin = await repos(identity.tenant, identity.user).conversations.readPinnedConversation(
      conversationId,
      registry.getFieldSchemas(),
    );
    if (!pin) return { ok: false, code: 'conversation_unavailable', message: MESSAGES.notFound };
    if (pin.state !== 'pinned') return { ok: false, code: 'legacy_unversioned', message: MESSAGES.legacy };
    await getOrchestrator().startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);
    return { ok: true, identity };
  } catch (error) {
    log.error({ conversationId, err: error }, 'conversationAccess.authorize_failed');
    return { ok: false, code: 'conversation_unavailable', message: MESSAGES.notFound };
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
