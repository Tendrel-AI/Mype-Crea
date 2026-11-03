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
import type { ConversationId, UUID } from '../core/contracts';
import { clientDeliverableUrl } from '../core/deliverable-url';
import { conversationListLabel } from './label';
import { briefPanelFields, type BriefPanelField } from './brief-panel';

export const CONVERSATION_NOT_FOUND_MESSAGE = 'No encontramos esta conversación.';
export const NEW_CONVERSATION_UNAVAILABLE_MESSAGE = 'No hay una configuración activa para iniciar una conversación nueva.';
export const NEW_CONVERSATION_FAILED_MESSAGE = 'No pudimos iniciar la conversación. Inténtalo de nuevo.';
export const CONVERSATIONS_UNAVAILABLE_MESSAGE = 'No pudimos cargar tus conversaciones. Inténtalo de nuevo.';

export interface ConversationListEntry {
  readonly conversationId: ConversationId;
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
}

export type OwnedConversationLoad =
  | { readonly state: 'loaded'; readonly history: ConversationHistory }
  | { readonly state: 'not_found' }
  | { readonly state: 'legacy_unversioned' };

export type NewOwnedConversation =
  | { readonly ok: true; readonly conversationId: ConversationId }
  | { readonly ok: false; readonly message: string };

/** What `/` shows. `redirect` keeps the selected id in the URL so a reload reopens it. */
export type HomeConversationResult =
  | { readonly kind: 'redirect'; readonly conversationId: ConversationId; readonly created: boolean }
  | {
      readonly kind: 'open';
      readonly history: ConversationHistory;
      readonly conversations: ReadonlyArray<ConversationListEntry>;
    }
  | {
      readonly kind: 'not_found';
      readonly message: typeof CONVERSATION_NOT_FOUND_MESSAGE;
      readonly conversations: ReadonlyArray<ConversationListEntry>;
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
    label: conversationListLabel(row),
    lastActivityAt: row.lastActivityAt,
  }));
}

/** Load the owner's durable trace. Foreign and missing ids are both `not_found`. */
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
        contentUrl: clientDeliverableUrl(deliverable),
        contentInline: deliverable.contentInline,
        selectedAt: deliverable.selectedAt ?? null,
        createdAt: deliverable.createdAt,
      })),
      brief: briefPanelFields(pin.snapshot),
    },
  };
}

/**
 * Create and durably pin a new conversation before the UI opens SSE. Never
 * touches the caller's other conversations: they stay listed (owner decision).
 */
export async function createOwnedConversation(identity: ResolvedIdentity): Promise<NewOwnedConversation> {
  const conversationId = randomUUID() as ConversationId;
  const registry = buildDefaultRegistry();
  const pinned = await repository(identity).conversations.ensurePinnedConversation({
    conversationId,
    schemas: registry.getFieldSchemas(),
  });
  if (pinned.state !== 'pinned') return { ok: false, message: NEW_CONVERSATION_UNAVAILABLE_MESSAGE };
  await getOrchestrator().startConversation(
    conversationId,
    identity.tenant.id as UUID,
    identity.user.id as UUID,
  );
  return { ok: true, conversationId };
}

/**
 * Decide what `/` shows for the signed-in user.
 * - No id: redirect to the most recent conversation by last activity; create one
 *   only when the user has none (legacy unversioned rows never count).
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
      const created = await createOwnedConversation(identity);
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
    const conversations = await listOwnedConversations(identity);
    if (load.state !== 'loaded') {
      return { kind: 'not_found', message: CONVERSATION_NOT_FOUND_MESSAGE, conversations };
    }
    return { kind: 'open', history: load.history, conversations };
  } catch {
    return { kind: 'error', message: 'No pudimos cargar esta conversación. Inténtalo de nuevo.' };
  }
}
