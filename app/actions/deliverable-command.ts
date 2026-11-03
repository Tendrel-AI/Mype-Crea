'use server';

/**
 * Deliverable command controller (KAN-28 / KAN-64 / KAN-65).
 *
 * The UI's Generar / Iterar / Aprobar / Reintentar / Cancelar buttons call
 * `deliverableCommandAction`; the panel reads `loadDeliverableStatesAction`.
 * This controller only authenticates, authorizes the conversation (owner +
 * pinned release), checks the input shape, and hands the command to the
 * core, which re-validates it against a fresh server-derived state. The
 * buttons the client renders are advisory; nothing here trusts them.
 *
 * «Avanzar» is UI navigation only and has no server path.
 */

import { getOrchestrator } from '../../src/core/orchestrator/runtime';
import { authorizeConversation as authorize, isUuid, type AccessFailureCode } from './conversation-access';
import { hasOnlyKeys, recordRejectedWrites } from './write-rejections';
import type { ResolvedIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import {
  MAX_ITERATION_OBSERVATION_LENGTH,
  type ConversationId,
  type DeliverableCommand,
  type DeliverableCommandKind,
  type DeliverableCommandResult,
  type DeliverableStateKind,
  type DeliverableStateView,
  type UUID,
} from '../../src/core/contracts';
import { codePointLength } from '../../src/core/refinement';
import { loggerFor } from '../../src/services/logger';
import { usageLimitMessage } from '../../src/services/usage/policy';

const log = loggerFor('controller.deliverable-command');

const COMMAND_KINDS: ReadonlyArray<DeliverableCommandKind> = ['generate', 'iterate', 'approve', 'retry', 'cancel'];
/** Commands that start a generation (KAN-43 preflight). */
const GENERATING_COMMANDS: ReadonlyArray<DeliverableCommandKind> = ['generate', 'iterate', 'retry'];
/** Agents whose generation is one LLM call (KAN-31, KAN-32); every other live agent generates an image. */
const LLM_AGENTS: ReadonlyArray<string> = ['name-agent', 'tagline-agent'];
const STATE_KINDS: ReadonlyArray<DeliverableStateKind> = [
  'blocked',
  'enabled',
  'generating',
  'in_review',
  'approved',
  'failed',
];

export type DeliverableStatesResult =
  | { readonly ok: true; readonly states: ReadonlyArray<DeliverableStateView> }
  | { readonly ok: false; readonly code: ControllerFailureCode; readonly message: string };

export type DeliverableCommandActionResult =
  | DeliverableCommandResult
  | {
      readonly ok: false;
      readonly code: ControllerFailureCode;
      readonly reason: 'invalid' | 'unavailable';
      readonly message: string;
      readonly states: ReadonlyArray<DeliverableStateView>;
    };

type ControllerFailureCode = AccessFailureCode | 'invalid_request' | 'usage_limited' | 'command_failed';

/** Client input: plain JSON from the browser, validated here. */
export interface DeliverableCommandInput {
  readonly commandId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly kind: string;
  readonly expectedState: string;
  readonly stateToken: string;
  readonly deliverableId?: string | null;
  readonly expectedApprovedId?: string | null;
  readonly taskId?: string;
  readonly failedTaskId?: string;
  readonly observation?: string;
}

const MESSAGES = {
  invalid: 'No pudimos validar esta acción.',
  observationTooLong: `Tu comentario puede tener hasta ${MAX_ITERATION_OBSERVATION_LENGTH} caracteres.`,
  failed: 'No pudimos completar esta acción. Inténtalo de nuevo.',
  loadFailed: 'No pudimos cargar el estado de tus entregables. Inténtalo de nuevo.',
} as const;

/** Server-derived states of every deliverable in the conversation. */
export async function loadDeliverableStatesAction(input: {
  readonly conversationId: string;
}): Promise<DeliverableStatesResult> {
  if (!isUuid(input?.conversationId)) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorize(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return authorized;
  try {
    return { ok: true, states: await getOrchestrator().getDeliverableStates(conversationId) };
  } catch (error) {
    log.error({ conversationId, err: error }, 'deliverableStates.failed');
    return { ok: false, code: 'command_failed', message: MESSAGES.loadFailed };
  }
}

/** Execute one typed deliverable command (re-validated by the core). */
export async function deliverableCommandAction(
  input: DeliverableCommandInput,
): Promise<DeliverableCommandActionResult> {
  // KAN-44: every refused command changes nothing and leaves a `write_rejections` row.
  const record = (reason: string, identity?: ResolvedIdentity) =>
    recordRejectedWrites(identity, [{
      channel: 'command',
      reason,
      offending: input,
      conversationId: (input as { conversationId?: unknown } | null)?.conversationId,
      agentId: (input as { agentId?: unknown } | null)?.agentId,
    }]);
  const parsed = parseCommand(input);
  if (!parsed.ok) {
    await record(parsed.reason);
    return { ok: false, code: 'invalid_request', reason: 'invalid', message: parsed.message, states: [] };
  }
  const command = parsed.command;
  // Commands dispatch agents with the user's brief: KAN-27 consent is required.
  const authorized = await authorize(command.conversationId, { requireDurability: true, requireTerms: true });
  if (!authorized.ok) {
    if (authorized.code === 'conversation_unavailable') await record('conversation_unavailable');
    return { ok: false, code: authorized.code, reason: 'unavailable', message: authorized.message, states: [] };
  }
  try {
    // KAN-43: refuse before any task row exists. The worker's reservation stays the guarantee.
    if (GENERATING_COMMANDS.includes(command.kind)) {
      const preflight = await repos(authorized.identity.tenant, authorized.identity.user).usage.preflight({
        kind: LLM_AGENTS.includes(command.agentId) ? 'llm' : 'image',
        estimatedCostUsd: 0,
        conversationId: command.conversationId,
      });
      if (!preflight.allowed) {
        log.warn(
          { conversationId: command.conversationId, kind: command.kind, commandId: command.commandId, reason: preflight.reason, reservationId: preflight.reservationId },
          'deliverableCommand.usage_denied',
        );
        return { ok: false, code: 'usage_limited', reason: 'unavailable', message: usageLimitMessage(preflight.reason), states: [] };
      }
    }
    const result = await getOrchestrator().executeCommand(command);
    if (!result.ok) await record(`command_${result.reason}`, authorized.identity);
    log.info(
      {
        conversationId: command.conversationId,
        agentId: command.agentId,
        kind: command.kind,
        commandId: command.commandId,
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
      },
      'deliverableCommand.complete',
    );
    return result;
  } catch (error) {
    log.error(
      { conversationId: command.conversationId, kind: command.kind, commandId: command.commandId, err: error },
      'deliverableCommand.failed',
    );
    return { ok: false, code: 'command_failed', reason: 'unavailable', message: MESSAGES.failed, states: [] };
  }
}

type Parsed =
  | { readonly ok: true; readonly command: DeliverableCommand }
  | { readonly ok: false; readonly reason: 'invalid_request' | 'invalid_value'; readonly message: string };

/** The only keys a command may carry; anything else (a forged actor, tenant, brief field…) is refused (KAN-44). */
const COMMAND_KEYS = [
  'commandId', 'conversationId', 'agentId', 'kind', 'expectedState', 'stateToken',
  'deliverableId', 'expectedApprovedId', 'taskId', 'failedTaskId', 'observation',
] as const;

function parseCommand(input: DeliverableCommandInput): Parsed {
  const invalid: Parsed = { ok: false, reason: 'invalid_request', message: MESSAGES.invalid };
  if (!hasOnlyKeys(input, COMMAND_KEYS)) return invalid;
  const { commandId, conversationId, agentId, kind, expectedState, stateToken } = input;
  if (!isUuid(commandId) || !isUuid(conversationId)) return invalid;
  if (typeof agentId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(agentId)) return invalid;
  if (!COMMAND_KINDS.includes(kind as DeliverableCommandKind)) return invalid;
  if (!STATE_KINDS.includes(expectedState as DeliverableStateKind)) return invalid;
  if (typeof stateToken !== 'string' || stateToken.length === 0 || stateToken.length > 64) return invalid;

  const base = {
    commandId: commandId as UUID,
    conversationId: conversationId as ConversationId,
    agentId,
    expectedState: expectedState as DeliverableStateKind,
    stateToken,
  };

  switch (kind as DeliverableCommandKind) {
    case 'generate':
      return { ok: true, command: { ...base, kind: 'generate' } };
    case 'cancel':
      if (!isUuid(input.taskId)) return invalid;
      return { ok: true, command: { ...base, kind: 'cancel', taskId: input.taskId } };
    case 'retry':
      if (!isUuid(input.failedTaskId)) return invalid;
      return { ok: true, command: { ...base, kind: 'retry', failedTaskId: input.failedTaskId } };
    case 'approve': {
      if (!isUuid(input.deliverableId)) return invalid;
      const expectedApprovedId = input.expectedApprovedId ?? null;
      if (expectedApprovedId !== null && !isUuid(expectedApprovedId)) return invalid;
      return {
        ok: true,
        command: { ...base, kind: 'approve', deliverableId: input.deliverableId, expectedApprovedId },
      };
    }
    case 'iterate': {
      const deliverableId = input.deliverableId ?? undefined;
      if (deliverableId !== undefined && !isUuid(deliverableId)) return invalid;
      const observation = input.observation;
      if (observation !== undefined && typeof observation !== 'string') return invalid;
      if (observation !== undefined && codePointLength(observation.trim()) > MAX_ITERATION_OBSERVATION_LENGTH) {
        return { ok: false, reason: 'invalid_value', message: MESSAGES.observationTooLong };
      }
      // Parameter overrides have no UI yet (KAN-28 open question); they are not accepted here.
      return {
        ok: true,
        command: {
          ...base,
          kind: 'iterate',
          ...(deliverableId ? { deliverableId } : {}),
          ...(observation !== undefined ? { observation } : {}),
        },
      };
    }
  }
}
