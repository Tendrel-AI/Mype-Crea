'use server';

import { randomUUID } from 'node:crypto';
import { resolveIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { buildDefaultRegistry } from '../../src/core/orchestrator/bootstrap-registry';
import { getOrchestrator } from '../../src/core/orchestrator/runtime';
import type { ConversationId, UUID } from '../../src/core/contracts';

export type NewConversationResult =
  | { readonly ok: true; readonly conversationId: ConversationId }
  | { readonly ok: false; readonly code: 'configuration_unavailable'; readonly message: string };

/** Create and durably pin a new conversation before the UI opens SSE. */
export async function createConversationAction(): Promise<NewConversationResult> {
  try {
    const identity = await resolveIdentity();
    const conversationId = randomUUID() as ConversationId;
    const registry = buildDefaultRegistry();
    const repository = repos(identity.tenant, identity.user);
    const pinned = await repository.conversations.ensurePinnedConversation({
      conversationId,
      schemas: registry.getFieldSchemas(),
    });
    if (pinned.state !== 'pinned') {
      return {
        ok: false,
        code: 'configuration_unavailable',
        message: 'No hay una configuración activa para iniciar una conversación nueva.',
      };
    }
    await getOrchestrator().startConversation(
      conversationId,
      identity.tenant.id as UUID,
      identity.user.id as UUID,
    );
    return { ok: true, conversationId };
  } catch {
    return {
      ok: false,
      code: 'configuration_unavailable',
      message: 'No pudimos iniciar la conversación. Inténtalo de nuevo.',
    };
  }
}

export type ConversationHistoryResult =
  | {
      readonly ok: true;
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
    }
  | {
      readonly ok: false;
      readonly code: 'conversation_unavailable' | 'legacy_unversioned';
      readonly message: string;
    };

/** Load only the authenticated owner's durable conversation trace. */
export async function loadConversationAction(input: {
  readonly conversationId: string;
}): Promise<ConversationHistoryResult> {
  try {
    const identity = await resolveIdentity();
    const conversationId = input.conversationId as ConversationId;
    const repository = repos(identity.tenant, identity.user);
    const registry = buildDefaultRegistry();
    const pin = await repository.conversations.readPinnedConversation(
      conversationId,
      registry.getFieldSchemas(),
    );
    if (!pin) {
      return {
        ok: false,
        code: 'conversation_unavailable',
        message: 'No encontramos esta conversación.',
      };
    }
    if (pin.state !== 'pinned') {
      return {
        ok: false,
        code: 'legacy_unversioned',
        message: 'Esta conversación usa una configuración anterior. Inicia una conversación nueva para continuar.',
      };
    }
    const turns = await repository.aiTurns.listTurns(conversationId);
    const deliverables = await repository.deliverables.listByConversation(conversationId);
    return {
      ok: true,
      conversationId,
      turns: await Promise.all(turns.map(async (turn) => ({
        requestId: turn.requestId,
        userMessage: turn.inputContent,
        content: turn.responseContent,
        stage: turn.stage,
        failureCategory: turn.failureCategory,
        notices: (await repository.aiTurns.listNotices(turn.id)).map(({ code, content }) => ({ code, content })),
        createdAt: turn.createdAt,
      }))),
      deliverables: deliverables.map(({ id, kind, contentUrl, contentInline, selectedAt, createdAt }) => ({
        id,
        kind,
        contentUrl,
        contentInline,
        selectedAt: selectedAt ?? null,
        createdAt,
      })),
    };
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
  if (!isUuid(input.conversationId)) {
    return { ok: false, code: 'conversation_unavailable', message: 'No encontramos esta conversación.' };
  }
  try {
    const identity = await resolveIdentity();
    const conversationId = input.conversationId as ConversationId;
    const repository = repos(identity.tenant, identity.user);
    const registry = buildDefaultRegistry();
    const pin = await repository.conversations.readPinnedConversation(conversationId, registry.getFieldSchemas());
    if (!pin) {
      return { ok: false, code: 'conversation_unavailable', message: 'No encontramos esta conversación.' };
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
        deliverables,
        exportedAt: new Date().toISOString(),
      }, null, 2),
    };
  } catch {
    return { ok: false, code: 'conversation_unavailable', message: 'No pudimos exportar esta conversación. Inténtalo de nuevo.' };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
