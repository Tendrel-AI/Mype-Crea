'use server';

import { repositoryActor, resolveIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import type { ConversationId, UUID } from '../../src/core/contracts';
import {
  BRAND_NOT_FOUND_MESSAGE,
  CONVERSATION_NOT_FOUND_MESSAGE,
  CONVERSATIONS_UNAVAILABLE_MESSAGE,
  NEW_CONVERSATION_FAILED_MESSAGE,
  createOwnedConversation,
  isConversationId,
  listOwnedBrands,
  listOwnedConversations,
  loadOwnedConversation,
  type ConversationHistory,
  type BrandListEntry,
  type ConversationListEntry,
  type NewOwnedConversation,
} from '../../src/conversations/selection';

export type NewConversationResult = NewOwnedConversation;

/**
 * Create and durably pin a new conversation under one of the caller's active brands before the UI
 * opens SSE. The caller's previous conversations are left untouched and stay listed (KAN-25).
 * A foreign, missing or archived brand gets the same not-found answer; the per-brand limit
 * (KAN-85) comes back as `conversation_limit_reached`.
 */
export async function createConversationAction(input: { readonly brandId: string }): Promise<NewConversationResult> {
  if (!isConversationId(input?.brandId)) {
    return { ok: false, code: 'brand_not_found', message: BRAND_NOT_FOUND_MESSAGE };
  }
  try {
    const identity = await resolveIdentity();
    return await createOwnedConversation(identity, input.brandId as UUID);
  } catch {
    return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_FAILED_MESSAGE };
  }
}

export type ConversationListResult =
  | { readonly ok: true; readonly conversations: ReadonlyArray<ConversationListEntry>; readonly brands: ReadonlyArray<BrandListEntry> }
  | { readonly ok: false; readonly code: 'conversations_unavailable'; readonly message: string };

/** KAN-25 «Mis conversaciones»: the caller's 20 most recent pinned conversations. */
export async function listConversationsAction(): Promise<ConversationListResult> {
  try {
    const identity = await resolveIdentity();
    const [conversations, brands] = await Promise.all([listOwnedConversations(identity), listOwnedBrands(identity)]);
    return { ok: true, conversations, brands };
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

/**
 * KAN-42: export the conversation's full ordered trace (turns, attempts, LLM calls, messages,
 * tasks, deliverables, approvals, usage, rejections). The owner and an active tenant admin of
 * the same tenant get it; anyone else gets the same not-found answer as for a missing id.
 */
export async function exportConversationTraceAction(input: {
  readonly conversationId: string;
}): Promise<ConversationTraceExportResult> {
  if (!isConversationId(input.conversationId)) {
    return { ok: false, code: 'conversation_unavailable', message: CONVERSATION_NOT_FOUND_MESSAGE };
  }
  try {
    const identity = await resolveIdentity();
    const timeline = await repos(identity.tenant, identity.user, repositoryActor(identity))
      .trace.timeline(input.conversationId as ConversationId);
    if (!timeline) {
      return { ok: false, code: 'conversation_unavailable', message: CONVERSATION_NOT_FOUND_MESSAGE };
    }
    return { ok: true, content: JSON.stringify(timeline, null, 2) };
  } catch {
    return { ok: false, code: 'conversation_unavailable', message: 'No pudimos exportar esta conversación. Inténtalo de nuevo.' };
  }
}
