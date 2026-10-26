'use server';

import { resolveIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { buildDefaultRegistry } from '../../src/core/orchestrator/bootstrap-registry';
import type { ConversationId } from '../../src/core/contracts';
import { clientDeliverableUrl } from '../../src/core/deliverable-url';
import {
  CONVERSATION_NOT_FOUND_MESSAGE,
  CONVERSATIONS_UNAVAILABLE_MESSAGE,
  NEW_CONVERSATION_FAILED_MESSAGE,
  createOwnedConversation,
  isConversationId,
  listOwnedConversations,
  loadOwnedConversation,
  type ConversationHistory,
  type ConversationListEntry,
} from '../../src/conversations/selection';

export type NewConversationResult =
  | { readonly ok: true; readonly conversationId: ConversationId }
  | { readonly ok: false; readonly code: 'configuration_unavailable'; readonly message: string };

/**
 * Create and durably pin a new conversation before the UI opens SSE. The
 * caller's previous conversations are left untouched and stay listed (KAN-25).
 */
export async function createConversationAction(): Promise<NewConversationResult> {
  try {
    const identity = await resolveIdentity();
    const created = await createOwnedConversation(identity);
    return created.ok
      ? { ok: true, conversationId: created.conversationId }
      : { ok: false, code: 'configuration_unavailable', message: created.message };
  } catch {
    return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_FAILED_MESSAGE };
  }
}

export type ConversationListResult =
  | { readonly ok: true; readonly conversations: ReadonlyArray<ConversationListEntry> }
  | { readonly ok: false; readonly code: 'conversations_unavailable'; readonly message: string };

/** KAN-25 «Mis conversaciones»: the caller's 20 most recent pinned conversations. */
export async function listConversationsAction(): Promise<ConversationListResult> {
  try {
    const identity = await resolveIdentity();
    return { ok: true, conversations: await listOwnedConversations(identity) };
  } catch {
    return { ok: false, code: 'conversations_unavailable', message: CONVERSATIONS_UNAVAILABLE_MESSAGE };
  }
}

export type ConversationHistoryResult =
  | ({ readonly ok: true } & ConversationHistory)
  | {
      readonly ok: false;
      readonly code: 'conversation_unavailable' | 'legacy_unversioned';
      readonly message: string;
    };

/**
 * Load only the authenticated owner's durable conversation trace. A malformed,
 * foreign or missing id gets the same not-found answer (KAN-25).
 */
export async function loadConversationAction(input: {
  readonly conversationId: string;
}): Promise<ConversationHistoryResult> {
  if (!isConversationId(input.conversationId)) {
    return { ok: false, code: 'conversation_unavailable', message: CONVERSATION_NOT_FOUND_MESSAGE };
  }
  try {
    const identity = await resolveIdentity();
    const load = await loadOwnedConversation(identity, input.conversationId);
    if (load.state === 'not_found') {
      return { ok: false, code: 'conversation_unavailable', message: CONVERSATION_NOT_FOUND_MESSAGE };
    }
    if (load.state === 'legacy_unversioned') {
      return {
        ok: false,
        code: 'legacy_unversioned',
        message: 'Esta conversación usa una configuración anterior. Inicia una conversación nueva para continuar.',
      };
    }
    return { ok: true, ...load.history };
  } catch {
    return {
      ok: false,
      code: 'conversation_unavailable',
      message: 'No pudimos cargar esta conversación. Inténtalo de nuevo.',
    };
  }
}

export type ConversationTraceExportResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly code: 'conversation_unavailable'; readonly message: string };

/** Export the caller's own persisted conversation and turn evidence. */
export async function exportConversationTraceAction(input: {
  readonly conversationId: string;
}): Promise<ConversationTraceExportResult> {
  if (!isConversationId(input.conversationId)) {
    return { ok: false, code: 'conversation_unavailable', message: CONVERSATION_NOT_FOUND_MESSAGE };
  }
  try {
    const identity = await resolveIdentity();
    const conversationId = input.conversationId as ConversationId;
    const repository = repos(identity.tenant, identity.user);
    const registry = buildDefaultRegistry();
    const pin = await repository.conversations.readPinnedConversation(conversationId, registry.getFieldSchemas());
    if (!pin) {
      return { ok: false, code: 'conversation_unavailable', message: CONVERSATION_NOT_FOUND_MESSAGE };
    }

    const [turns, messages, deliverables, release] = await Promise.all([
      repository.aiTurns.listTurns(conversationId),
      repository.messages.listByConversation(conversationId),
      repository.deliverables.listByConversation(conversationId),
      repository.aiConfig.getPinnedRelease(conversationId),
    ]);
    const turnEvidence = await Promise.all(turns.map(async (turn) => {
      const [attempts, notices] = await Promise.all([
        repository.aiTurns.listAttempts({ turnId: turn.id }),
        repository.aiTurns.listNotices(turn.id),
      ]);
      return { turn, attempts, notices };
    }));

    return {
      ok: true,
      content: JSON.stringify({
        conversation: {
          id: conversationId,
          configurationState: pin.state,
          releaseId: pin.releaseId,
          releaseContentHash: release?.contentHash ?? null,
        },
        turns: turnEvidence,
        messages,
        // The export is a client download too: no provider URL or bucket key for stored images.
        // (JSON.stringify drops the undefined key.)
        deliverables: deliverables.map((deliverable) => ({
          ...deliverable,
          contentUrl: clientDeliverableUrl(deliverable),
          storageKey: undefined,
        })),
        exportedAt: new Date().toISOString(),
      }, null, 2),
    };
  } catch {
    return { ok: false, code: 'conversation_unavailable', message: 'No pudimos exportar esta conversación. Inténtalo de nuevo.' };
  }
}
