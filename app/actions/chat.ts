'use server';

import { resolveIdentity, type ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import { buildDefaultRegistry } from '../../src/core/orchestrator/bootstrap-registry';
import { getChatInputAdapter, getChatOutputAdapter, getOrchestrator } from '../../src/core/orchestrator/runtime';
import type { ConversationId, FieldDelta, PlannerDecision, UUID } from '../../src/core/contracts';
import type { AiTurnRow, AiTurnStage } from '../../src/repos/models';
import type { JsonValue } from '../../src/services/ai-config/manifest';
import { AiConfigRuntime, AiConfigExecutionError, type AttemptWriter } from '../../src/services/ai-config/execution';
import { captureRuntimeIdentity } from '../../src/services/ai-config/baseline';
import { ProviderRegistry } from '../../src/services/ai-config/provider-registry';
import { activePromptVersions } from '../../src/services/prompts';
import { loggerFor } from '../../src/services/logger';
import { checkCurrentTerms } from '../../src/consent/gate';
import { TERMS_REQUIRED_MESSAGE, TERMS_UNAVAILABLE_MESSAGE } from '../../src/consent/terms';
import { inputChars, usageLimitMessage } from '../../src/services/usage/policy';
import { ConversationUnavailableError } from '../../src/repos/conversations';
import { hasOnlyKeys, recordRejectedWrites } from './write-rejections';
import { isUuid as isAnyUuid } from './conversation-access';
import { priorDecisionFrom } from './prior-decision';

/** The only keys a chat turn may carry (KAN-44). */
const CHAT_KEYS = ['conversationId', 'requestId', 'userMessage'] as const;

const log = loggerFor('controller.chat');

export type ChatActionResult =
  | {
      readonly ok: true;
      readonly conversationId: ConversationId;
      readonly turnId: UUID;
      readonly requestId: UUID;
      readonly content: string;
      readonly notices: ReadonlyArray<{ readonly code: string; readonly content: string | null }>;
    }
  | {
      readonly ok: false;
      readonly conversationId: ConversationId;
      readonly requestId: UUID;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly uncertain: boolean;
    };

/** Execute or recover one owner-scoped, version-pinned chat turn. */
export async function chatAction(params: {
  readonly conversationId: string;
  readonly requestId: string;
  readonly userMessage: string;
}): Promise<ChatActionResult> {
  const conversationId = (params as { conversationId?: unknown } | null)?.conversationId as ConversationId;
  const requestId = (params as { requestId?: unknown } | null)?.requestId as UUID;
  // KAN-44: only a chat message is accepted here (no panel field, forged actor or tenant); a refusal is logged.
  if (
    !hasOnlyKeys(params, CHAT_KEYS) ||
    typeof requestId !== 'string' || !isUuid(requestId) ||
    !isAnyUuid(conversationId) ||
    typeof params.userMessage !== 'string'
  ) {
    await recordRejectedWrites(undefined, [{ channel: 'chat', reason: 'invalid_request', offending: params, conversationId }]);
    return failure(conversationId, requestId, 'invalid_request', 'No pudimos validar tu solicitud.', false, false);
  }
  const userMessage = params.userMessage.trim();
  if (!userMessage) {
    return failure(conversationId, requestId, 'empty_message', 'Escribe un mensaje para continuar.', false, false);
  }

  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity();
  } catch {
    return failure(conversationId, requestId, 'identity_unavailable', 'No pudimos verificar el acceso de tu cuenta. Inténtalo de nuevo.', true, false);
  }
  // KAN-27: no conversation, turn or LLM work without acceptance of the current terms.
  const terms = await checkCurrentTerms(identity);
  if (terms === 'required') {
    return failure(conversationId, requestId, 'terms_required', TERMS_REQUIRED_MESSAGE, false, false);
  }
  if (terms !== 'accepted') {
    return failure(conversationId, requestId, 'terms_unavailable', TERMS_UNAVAILABLE_MESSAGE, true, false);
  }
  if (process.env.NODE_ENV !== 'test' && !process.env.REDIS_URL) {
    return failure(conversationId, requestId, 'durability_unavailable', 'El servicio de tareas duraderas no está disponible. Inténtalo más tarde.', true, false);
  }
  const repository = repos(identity.tenant, identity.user);
  const registry = buildDefaultRegistry();
  const orchestrator = getOrchestrator();
  const inputAdapter = getChatInputAdapter();
  const outputAdapter = getChatOutputAdapter();
  let activeTurn: AiTurnRow | undefined;
  let activeOwnerToken: UUID | undefined;
  let safeStage: AiTurnStage = 'reserved';

  try {
    // Pin and authorize the conversation before touching core state or its actor cache.
    const pin = await repository.conversations.ensurePinnedConversation({
      conversationId,
      schemas: registry.getFieldSchemas(),
    });
    if (pin.state !== 'pinned') {
      return failure(conversationId, requestId, 'legacy_unversioned', 'Esta conversación usa una configuración anterior. Inicia una conversación nueva para continuar.', false, false);
    }
    // D22: the first turn pins the active prompt versions; later turns read them back.
    const promptVersions = await repository.conversationPrompts.pin(conversationId, activePromptVersions());
    log.info({ conversationId, promptVersions }, 'chatAction.prompt_versions');
    await orchestrator.startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);

    // KAN-43: input cap and room for a full turn (extractor + responder) before any turn row
    // exists. Each provider call still reserves on its own; this only avoids half-run turns.
    // A retry of an already answered request skips it: claimTurn replays the stored reply.
    const answered = (await repository.aiTurns.listTurns(conversationId))
      .some((turn) => turn.requestId === requestId && turn.stage === 'responded');
    if (!answered) {
      const preflight = await repository.usage.preflight({
        kind: 'llm',
        calls: 2,
        estimatedCostUsd: 0,
        inputChars: inputChars(userMessage),
        conversationId,
      });
      if (!preflight.allowed) {
        log.warn({ conversationId, requestId, reason: preflight.reason, reservationId: preflight.reservationId }, 'chatAction.usage_denied');
        return failure(conversationId, requestId, 'usage_limited', usageLimitMessage(preflight.reason), false, false);
      }
    }

    const claim = await repository.aiTurns.claimTurn({ conversationId, requestId, inputContent: userMessage });
    if (claim.kind === 'conflict') {
      await recordRejectedWrites(identity, [{ channel: 'chat', reason: 'request_conflict', offending: userMessage, conversationId }]);
      return failure(conversationId, requestId, 'request_conflict', 'Esta solicitud ya se usó con otro mensaje. Inicia una nueva solicitud.', false, false);
    }
    if (claim.kind === 'in_progress') {
      return failure(conversationId, requestId, 'turn_in_progress', 'Tu solicitud sigue procesándose. Espera un momento y vuelve a cargar la conversación.', true, false);
    }
    if (claim.kind === 'uncertain') {
      return failure(conversationId, requestId, 'turn_uncertain', 'No pudimos confirmar el resultado de esta solicitud. Tu progreso está protegido; revisa la conversación antes de intentar algo nuevo.', false, true);
    }
    if (claim.kind === 'completed') {
      const notices = await repository.aiTurns.listNotices(claim.turn.id);
      return {
        ok: true,
        conversationId,
        turnId: claim.turn.id,
        requestId,
        content: claim.turn.responseContent ?? '',
        notices: notices.map(({ code, content }) => ({ code, content })),
      };
    }
    if (claim.kind !== 'acquired') {
      return failure(conversationId, requestId, 'turn_unavailable', 'No pudimos recuperar esta solicitud. Recarga la conversación.', true, false);
    }

    let turn = claim.turn;
    activeTurn = turn;
    activeOwnerToken = claim.ownerToken;
    safeStage = turn.stage;
    let payload = turn.payload;
    const configRuntime = await buildAiConfigRuntime(identity);
    const llmContext = {
      tenant: identity.tenant,
      user: identity.user,
      conversationId,
      promptVersion: 'chatAction.v2',
    };

    if (turn.stage === 'reserved') {
      await repository.aiTurns.ensureUserMessage({ turnId: turn.id, ownerToken: claim.ownerToken, conversationId, content: userMessage });
      const priorDecision = priorDecisionFrom(await repository.aiTurns.listTurns(conversationId), turn.id);
      const unasked = new Map<string, unknown>();
      const extracted = await configRuntime.runPurpose(
        identity,
        { conversationId, turnId: turn.id, ownerToken: claim.ownerToken, purpose: 'extractor' },
        (execution) => inputAdapter.extract({
          conversationId,
          userMessage,
          priorDecision,
          llmContext,
          execution,
          promptVersions,
          onUnaskedFields: (fields) => fields.forEach(({ name, value }) => unasked.set(name, value)),
        }),
      );
      // KAN-44: fields the model returned outside what this turn asked for are never stored; log the refusal.
      await recordRejectedWrites(identity, [...unasked].map(([name, value]) => ({
        channel: 'chat' as const, reason: 'unknown_field', offending: value, conversationId, fieldName: name,
      })));
      payload = {
        ...payload,
        delta: extracted.value as unknown as JsonValue,
        effectiveExtractorProfileId: extracted.effectiveProfileId,
      };
      turn = await repository.aiTurns.checkpointTurn({ turnId: turn.id, ownerToken: claim.ownerToken, expectedVersion: turn.version, stage: 'extracted', payload: asJsonRecord(payload) });
      safeStage = turn.stage;
      payload = turn.payload;
    }

    if (turn.stage === 'extracted') {
      const delta = fieldDelta(payload['delta']);
      // Fence before side effects. A crash after this point is uncertain and never replayed.
      turn = await repository.aiTurns.checkpointTurn({ turnId: turn.id, ownerToken: claim.ownerToken, expectedVersion: turn.version, stage: 'effects_started', payload: asJsonRecord(payload) });
      safeStage = turn.stage;
      const { rejected } = await orchestrator.applyDelta(delta);
      await recordRejectedWrites(identity, rejected.map((write) => ({
        channel: 'chat' as const,
        reason: write.reason,
        offending: write.target === 'value'
          ? delta.fields[write.agentId]?.[write.fieldName]?.value
          : delta.intents?.find((intent) => intent.kind === 'reset_field' && intent.agentId === write.agentId && intent.fieldName === write.fieldName),
        conversationId,
        agentId: write.agentId,
        fieldName: write.fieldName,
      })));
      const decisions = await orchestrator.peekNextDecision(conversationId);
      const snapshot = await orchestrator.getSnapshot(conversationId);
      payload = { ...payload, decisions: decisions as unknown as JsonValue, snapshot: snapshot as unknown as JsonValue };
      turn = await repository.aiTurns.checkpointTurn({ turnId: turn.id, ownerToken: claim.ownerToken, expectedVersion: turn.version, stage: 'effects_committed', payload: asJsonRecord(payload) });
      safeStage = turn.stage;
      await orchestrator.acknowledgeDecisions(conversationId, decisions);
    }

    if (turn.stage !== 'effects_committed') {
      throw new Error(`Unsupported recoverable turn stage: ${turn.stage}`);
    }
    const decisions = decisionArray(payload['decisions']);
    const snapshot = await orchestrator.getSnapshot(conversationId);
    // Most recent 10 (DESC), back to chronological order for the Responder.
    const recentMessages = (await repository.messages.listByConversation(conversationId, { limit: 10, orderDescending: true })).reverse();
    const context = (await repository.conversations.context(conversationId)) ?? null;
    const rendered = await configRuntime.runPurpose(
      identity,
      { conversationId, turnId: turn.id, ownerToken: claim.ownerToken, purpose: 'responder' },
      (execution) => outputAdapter.render({ decisions, recentMessages, snapshot, llmContext, execution, promptVersions, context }),
    );
    const completed = await repository.aiTurns.completeTurn({ turnId: turn.id, ownerToken: claim.ownerToken, responseContent: rendered.value.content });
    log.info({ conversationId, turnId: turn.id, decisionKinds: decisions.map((decision) => decision.kind) }, 'chatAction.complete');
    return {
      ok: true,
      conversationId,
      turnId: turn.id,
      requestId,
      content: completed.turn.responseContent ?? '',
      notices: completed.notices.map(({ code, content }) => ({ code, content })),
    };
  } catch (error) {
    if (error instanceof ConversationUnavailableError) {
      // A forged id that belongs to another user or tenant: nothing was created (KAN-44).
      await recordRejectedWrites(identity, [{ channel: 'chat', reason: 'conversation_unavailable', offending: params, conversationId }]);
      return failure(conversationId, requestId, 'conversation_unavailable', 'No encontramos esta conversación.', false, false);
    }
    const executionError = error instanceof AiConfigExecutionError ? error : undefined;
    const ambiguous = Boolean(executionError?.ambiguous);
    if (activeTurn && activeOwnerToken) {
      try {
        await repository.aiTurns.failTurn({
          turnId: activeTurn.id,
          ownerToken: activeOwnerToken,
          category: executionError?.category ?? 'turn_failed',
          uncertain: ambiguous || safeStage === 'effects_started',
          stage: ambiguous || safeStage === 'effects_started' ? 'uncertain' : safeStage,
        });
      } catch {
        // A lost lease or persistence outage is surfaced as an uncertain turn on reload.
      }
    }
    log.error({ conversationId, requestId, category: executionError?.category ?? 'turn_failed', correlationId: executionError?.correlationId }, 'chatAction.failed');
    return failure(
      conversationId,
      requestId,
      executionError?.category ?? 'turn_failed',
      executionError?.usageDenial
        ? usageLimitMessage(executionError.usageDenial)
        : executionError ? publicExecutionMessage(executionError.category) : 'No pudimos completar tu solicitud. Inténtalo de nuevo.',
      Boolean(executionError?.retryable),
      ambiguous,
    );
  }
}

// Hashing the sources and building the registry once per process; a turn must not re-validate env models.
let runtimeIdentity: ReturnType<typeof captureRuntimeIdentity> | undefined;
const providerRegistry = new ProviderRegistry();

async function buildAiConfigRuntime(_identity: ResolvedIdentity): Promise<AiConfigRuntime> {
  runtimeIdentity ??= captureRuntimeIdentity();
  const { runtimeVersion, codeFingerprint, dependencyFingerprint } = await runtimeIdentity.catch((error) => {
    runtimeIdentity = undefined; // do not cache a failure
    throw error;
  });
  const repositoriesFor = (resolved: ResolvedIdentity) => {
    const scoped = repos(resolved.tenant, resolved.user);
    return {
      config: {
        async getPinnedRelease(conversationId: string) {
          const release = await scoped.aiConfig.getPinnedRelease(conversationId);
          if (!release) return undefined;
          return { state: 'pinned' as const, release: { id: release.id, status: release.status, manifest: release.manifest, contentHash: release.contentHash } };
        },
        async getProviderAvailability(provider: 'openrouter' | 'anthropic') {
          const availability = await scoped.aiConfig.getProviderAvailability(provider);
          return { enabled: availability.enabled, version: availability.version };
        },
      },
      attempts: {
        startAttempt: (input: Parameters<typeof scoped.aiTurns.startAttempt>[0]) => scoped.aiTurns.startAttempt(input),
        attachAttemptRequest: (input: Parameters<typeof scoped.aiTurns.attachAttemptRequest>[0]) => scoped.aiTurns.attachAttemptRequest(input),
        listAttempts: (input: Parameters<typeof scoped.aiTurns.listAttempts>[0]) => scoped.aiTurns.listAttempts(input),
        finishAttempt: (input: Parameters<AttemptWriter['finishAttempt']>[0]) => scoped.aiTurns.finishAttempt({ ...input, cost: undefined }),
        async recordNotice(input: Parameters<typeof scoped.aiTurns.recordNotice>[0]) {
          await scoped.aiTurns.recordNotice(input);
        },
      },
      usage: scoped.usage,
    };
  };
  return new AiConfigRuntime(repositoriesFor, providerRegistry, { runtimeVersion, codeFingerprint, dependencyFingerprint });
}

function fieldDelta(value: JsonValue | undefined): FieldDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved extraction is unavailable.');
  return value as unknown as FieldDelta;
}

function decisionArray(value: JsonValue | undefined): PlannerDecision[] {
  return Array.isArray(value) ? value as unknown as PlannerDecision[] : [];
}

function asJsonRecord(value: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicExecutionMessage(category: AiConfigExecutionError['category']): string {
  switch (category) {
    case 'legacy_unversioned': return 'Esta conversación usa una configuración anterior. Inicia una conversación nueva para continuar.';
    case 'unsupported_release':
    case 'release_unavailable': return 'La configuración de esta conversación ya no está disponible. Contacta al administrador de tu organización.';
    case 'ambiguous_provider_outcome': return 'No pudimos confirmar el resultado de esta solicitud. Tu progreso está protegido; revisa la conversación antes de intentar algo nuevo.';
    case 'provider_unavailable':
    case 'profile_unavailable': return 'El servicio de generación no está disponible. Inténtalo más tarde.';
    default: return 'No pudimos completar tu solicitud. Inténtalo de nuevo.';
  }
}

function failure(
  conversationId: ConversationId,
  requestId: UUID,
  code: string,
  message: string,
  retryable: boolean,
  uncertain: boolean,
): ChatActionResult {
  return { ok: false, conversationId, requestId, code, message, retryable, uncertain };
}
