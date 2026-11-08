/**
 * KAN-25: which conversation a signed-in user sees, and the list they can switch to.
 *
 * Server-only. This is THE selection logic (KAN-30 state recovery builds on it):
 * the home page and the conversation server actions all go through these
 * functions, never through their own queries. Every read is owner-scoped through
 * `repos(tenant, user)` (RLS + explicit tenant/owner predicates), so a foreign,
 * missing or malformed id produces one identical "not found" outcome.
 */
import { randomUUID } from 'node:crypto';
import { resolveIdentity, type ResolvedIdentity } from '../auth/resolve-identity';
import { repos } from '../repos';
import { buildDefaultRegistry } from '../core/orchestrator/bootstrap-registry';
import { getOrchestrator } from '../core/orchestrator/runtime';
import type { ConversationId, DeliverableStateView, UUID } from '../core/contracts';
import { clientDeliverableUrl } from '../core/deliverable-url';
import { loggerFor } from '../services/logger';
import { conversationListLabel } from './label';
import { briefPanelFields, type BriefPanelField } from './brief-panel';

const log = loggerFor('conversations.selection');

export const CONVERSATION_NOT_FOUND_MESSAGE = 'No encontramos esta conversación.';
export const NEW_CONVERSATION_UNAVAILABLE_MESSAGE = 'No hay una configuración activa para iniciar una conversación nueva.';
export const NEW_CONVERSATION_FAILED_MESSAGE = 'No pudimos iniciar la conversación. Inténtalo de nuevo.';
export const CONVERSATIONS_UNAVAILABLE_MESSAGE = 'No pudimos cargar tus conversaciones. Inténtalo de nuevo.';

export const brandLimitMessage = (limit: number) =>
  `Llegaste al límite de ${limit} marcas de tu organización. Archiva una marca o pide a tu administrador que lo aumente.`;
export const conversationLimitMessage = (limit: number) => `Esta marca llegó al límite de ${limit} conversaciones.`;
export const BRAND_NOT_FOUND_MESSAGE = 'No encontramos esta marca.';

/** A brand in «Mis conversaciones»; `name` is null until the brief names the business. */
export interface BrandListEntry {
  readonly brandId: UUID;
  readonly name: string | null;
}

export interface ConversationListEntry {
  readonly conversationId: ConversationId;
  /** KAN-85: null for conversations created before brands existed. */
  readonly brandId: UUID | null;
  /** «Café Andino · 24 oct» / «Nueva conversación · 24 oct». */
  readonly label: string;
  readonly lastActivityAt: string;
}

export interface ConversationHistory {
  readonly conversationId: ConversationId;
  readonly turns: ReadonlyArray<{
    readonly requestId: UUID;
    readonly userMessage: string | null;
    readonly content: string | null;
    readonly stage: string;
    readonly failureCategory: string | null;
    readonly notices: ReadonlyArray<{ readonly code: string; readonly content: string | null }>;
    readonly createdAt: string;
  }>;
  readonly deliverables: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly contentUrl: string | null;
    readonly contentInline: Record<string, unknown> | null;
    /** Set on the approved candidate of its kind (KAN-28 Aprobar), else null. */
    readonly selectedAt: string | null;
    readonly createdAt: string;
  }>;
  /** The persisted brief, so a resumed conversation renders it on first paint. */
  readonly brief: ReadonlyArray<BriefPanelField>;
  /**
   * KAN-30: server-derived deliverable states (tasks in progress, failures,
   * candidates, approvals) on first paint. Read-only: deriving them never
   * dispatches. Empty when they could not be read; the client reloads them.
   */
  readonly states: ReadonlyArray<DeliverableStateView>;
}

export type OwnedConversationLoad =
  | { readonly state: 'loaded'; readonly history: ConversationHistory }
  | { readonly state: 'not_found' }
  | { readonly state: 'legacy_unversioned' };

export type NewOwnedConversation =
  | { readonly ok: true; readonly conversationId: ConversationId; readonly brandId: UUID }
  | {
      readonly ok: false;
      readonly code: 'brand_limit_reached' | 'conversation_limit_reached' | 'brand_not_found' | 'configuration_unavailable';
      readonly message: string;
      readonly limit?: number;
    };

/** What `/` shows. `redirect` keeps the selected id in the URL so a reload reopens it. */
export type HomeConversationResult =
  | { readonly kind: 'redirect'; readonly conversationId: ConversationId; readonly created: boolean }
  | {
      readonly kind: 'open';
      readonly history: ConversationHistory;
      readonly conversations: ReadonlyArray<ConversationListEntry>;
      readonly brands: ReadonlyArray<BrandListEntry>;
    }
  | {
      readonly kind: 'not_found';
      readonly message: typeof CONVERSATION_NOT_FOUND_MESSAGE;
      readonly conversations: ReadonlyArray<ConversationListEntry>;
      readonly brands: ReadonlyArray<BrandListEntry>;
    }
  | { readonly kind: 'error'; readonly message: string };

/** Canonical RFC 4122 UUID (versions 1-8). Anything else never reaches SQL. */
export function isConversationId(value: unknown): value is ConversationId {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function repository(identity: ResolvedIdentity) {
  return repos(identity.tenant, identity.user);
}

/** The owner's latest pinned conversations (max 20) by last activity, labelled server-side. */
export async function listOwnedConversations(
  identity: ResolvedIdentity,
): Promise<ConversationListEntry[]> {
  const rows = await repository(identity).conversations.listRecent();
  return rows.map((row) => ({
    conversationId: row.conversationId,
    brandId: row.brandId ?? null,
    label: conversationListLabel(row),
    lastActivityAt: row.lastActivityAt,
  }));
}

/** The owner's active brands, named by the brand or by its newest conversation's business name. */
export async function listOwnedBrands(identity: ResolvedIdentity): Promise<BrandListEntry[]> {
  const rows = await repository(identity).brands.listActive();
  return rows.map((row) => ({ brandId: row.id, name: row.name }));
}

/**
 * Load the owner's durable trace. Foreign and missing ids are both `not_found`.
 * // shortcut: a conversation of an archived brand still opens by direct URL (it only leaves the list); revisit if archived brands must be read-only.
 */
export async function loadOwnedConversation(
  identity: ResolvedIdentity,
  conversationId: ConversationId,
): Promise<OwnedConversationLoad> {
  const owned = repository(identity);
  const registry = buildDefaultRegistry();
  const pin = await owned.conversations.readPinnedConversation(conversationId, registry.getFieldSchemas());
  if (!pin) return { state: 'not_found' };
  if (pin.state !== 'pinned') return { state: 'legacy_unversioned' };
  const turns = await owned.aiTurns.listTurns(conversationId);
  const deliverables = await owned.deliverables.listByConversation(conversationId);
  const states = await deliverableStates(identity, conversationId);
  return {
    state: 'loaded',
    history: {
      conversationId,
      turns: await Promise.all(turns.map(async (turn) => ({
        requestId: turn.requestId,
        userMessage: turn.inputContent,
        content: turn.responseContent,
        stage: turn.stage,
        failureCategory: turn.failureCategory,
        notices: (await owned.aiTurns.listNotices(turn.id)).map(({ code, content }) => ({ code, content })),
        createdAt: turn.createdAt,
      }))),
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        kind: deliverable.kind,
        // A stored image is only ever exposed through the authorized asset route (KAN-52).
        contentUrl: clientDeliverableUrl({ ...deliverable, metadata: deliverable.artifactMetadata ?? deliverable.contentInline?.metadata }),
        contentInline: deliverable.contentInline,
        selectedAt: deliverable.selectedAt ?? null,
        createdAt: deliverable.createdAt,
      })),
      brief: briefPanelFields(pin.snapshot),
      states,
    },
  };
}

/** Same read as the panel's `loadDeliverableStatesAction`, for an already authorized owner. */
async function deliverableStates(identity: ResolvedIdentity, conversationId: ConversationId): Promise<ReadonlyArray<DeliverableStateView>> {
  try {
    const core = getOrchestrator();
    await core.startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);
    return await core.getDeliverableStates(conversationId);
  } catch (error) {
    log.error({ conversationId, err: error }, 'selection.states_failed');
    return [];
  }
}

/** Start the orchestrator for a conversation that was just pinned. */
async function startPinned(identity: ResolvedIdentity, conversationId: ConversationId): Promise<void> {
  await getOrchestrator().startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);
}

/**
 * KAN-85 «Crear marca»: create a brand and its first conversation in one transaction (limit checked
 * there), then start the orchestrator. At the brand limit nothing is created.
 */
export async function createOwnedBrand(identity: ResolvedIdentity): Promise<NewOwnedConversation> {
  const conversationId = randomUUID() as ConversationId;
  const created = await repository(identity).brands.create({
    firstConversation: { conversationId, schemas: buildDefaultRegistry().getFieldSchemas() },
  });
  if (!created.ok) {
    return { ok: false, code: created.code, limit: created.limit, message: brandLimitMessage(created.limit) };
  }
  if (created.pin?.state !== 'pinned') return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_UNAVAILABLE_MESSAGE };
  await startPinned(identity, conversationId);
  log.debug({ brandId: created.brandId, conversationId }, 'selection.brand_created');
  return { ok: true, conversationId, brandId: created.brandId };
}

/**
 * Create and durably pin a new conversation under one of the owner's active brands before the UI
 * opens SSE. Never touches the caller's other conversations: they stay listed (owner decision).
 */
export async function createOwnedConversation(identity: ResolvedIdentity, brandId: UUID): Promise<NewOwnedConversation> {
  const conversationId = randomUUID() as ConversationId;
  const created = await repository(identity).brands.createConversation({
    brandId,
    conversationId,
    schemas: buildDefaultRegistry().getFieldSchemas(),
  });
  if (!created.ok) {
    return created.code === 'brand_not_found'
      ? { ok: false, code: 'brand_not_found', message: BRAND_NOT_FOUND_MESSAGE }
      : { ok: false, code: created.code, limit: created.limit, message: conversationLimitMessage(created.limit) };
  }
  if (created.pin.state !== 'pinned') return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_UNAVAILABLE_MESSAGE };
  await startPinned(identity, conversationId);
  return { ok: true, conversationId, brandId };
}

/**
 * Decide what `/` shows for the signed-in user.
 * - No id: redirect to the most recent conversation by last activity; create one
 *   only when the user has none (legacy unversioned rows never count): a brand plus its first
 *   conversation, or the brand-limit message when the user cannot create another brand.
 * - An id: open it when it is the caller's own pinned conversation. Foreign
 *   (other user or tenant), missing, malformed and legacy ids all return the
 *   same `not_found` value, with the caller's own list so they can move on.
 */
export async function resolveHomeConversation(requestedId: string | string[] | undefined): Promise<HomeConversationResult> {
  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity();
  } catch {
    return { kind: 'error', message: NEW_CONVERSATION_FAILED_MESSAGE };
  }

  if (requestedId === undefined) {
    try {
      const [latest] = await repository(identity).conversations.listRecent(1);
      if (latest) return { kind: 'redirect', conversationId: latest.conversationId, created: false };
    } catch {
      return { kind: 'error', message: CONVERSATIONS_UNAVAILABLE_MESSAGE };
    }
    try {
      const created = await createOwnedBrand(identity);
      return created.ok
        ? { kind: 'redirect', conversationId: created.conversationId, created: true }
        : { kind: 'error', message: created.message };
    } catch {
      return { kind: 'error', message: NEW_CONVERSATION_FAILED_MESSAGE };
    }
  }

  try {
    const load = isConversationId(requestedId)
      ? await loadOwnedConversation(identity, requestedId)
      : { state: 'not_found' as const };
    const [conversations, brands] = await Promise.all([listOwnedConversations(identity), listOwnedBrands(identity)]);
    if (load.state !== 'loaded') {
      return { kind: 'not_found', message: CONVERSATION_NOT_FOUND_MESSAGE, conversations, brands };
    }
    return { kind: 'open', history: load.history, conversations, brands };
  } catch {
    return { kind: 'error', message: 'No pudimos cargar esta conversación. Inténtalo de nuevo.' };
  }
}
