'use server';

/**
 * Brief panel controller (KAN-26).
 *
 * The panel reads the brief with `loadBriefAction` and edits one field with
 * `updateBriefFieldAction`. An edit becomes a `FieldDelta` (confidence 1.0 =
 * literal UI input, fanned out to every agent that owns the field) and goes
 * through `applyDelta`, the same merge/planner path a chat turn uses, so the
 * brief catalog validates both channels with one rule. The response carries
 * the fresh brief and the server-derived deliverable states, so the panel's
 * «Generar» button always reflects the server's verdict after the edit.
 */

import { buildDefaultRegistry } from '../../src/core/orchestrator/bootstrap-registry';
import { getOrchestrator } from '../../src/core/orchestrator/runtime';
import { briefFieldSpec, validateBriefValue } from '../../src/core/brief';
import { BRIEF_PANEL_SOURCE, briefPanelFields, type BriefPanelField } from '../../src/conversations/brief-panel';
import type { ConversationId, DeliverableStateView, FieldDelta } from '../../src/core/contracts';
import { loggerFor } from '../../src/services/logger';
import { authorizeConversation, isUuid, type AccessFailureCode } from './conversation-access';
import { hasOnlyKeys, recordRejectedWrites } from './write-rejections';
import type { ResolvedIdentity } from '../../src/auth/resolve-identity';

const log = loggerFor('controller.brief');

export type { BriefPanelField };

type BriefFailureCode = AccessFailureCode | 'invalid_request' | 'invalid_value' | 'brief_failed';

export type BriefResult =
  | { readonly ok: true; readonly fields: ReadonlyArray<BriefPanelField>; readonly states: ReadonlyArray<DeliverableStateView> }
  | { readonly ok: false; readonly code: BriefFailureCode; readonly message: string };

const MESSAGES = {
  invalid: 'No pudimos validar este dato.',
  loadFailed: 'No pudimos cargar los datos de tu marca. Inténtalo de nuevo.',
  saveFailed: 'No pudimos guardar este dato. Inténtalo de nuevo.',
} as const;

/** The brief and the deliverable states of an owned conversation. */
export async function loadBriefAction(input: { readonly conversationId: string }): Promise<BriefResult> {
  if (!isUuid(input?.conversationId)) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorizeConversation(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return authorized;
  try {
    return await currentBrief(conversationId);
  } catch (error) {
    log.error({ conversationId, err: error }, 'brief.load_failed');
    return { ok: false, code: 'brief_failed', message: MESSAGES.loadFailed };
  }
}

/** The only keys a panel edit may carry; anything else (a forged actor, tenant, agent…) is refused (KAN-44). */
const UPDATE_KEYS = ['conversationId', 'fieldName', 'value'] as const;

/** Set one brief field from the panel, through the same merge path as chat. */
export async function updateBriefFieldAction(input: {
  readonly conversationId: string;
  readonly fieldName: string;
  readonly value: string;
}): Promise<BriefResult> {
  // KAN-44: every refusal below changes nothing and leaves a `write_rejections` row.
  const refuse = async (
    reason: string,
    code: BriefFailureCode,
    message: string,
    detail: { readonly fieldName?: string; readonly offending?: unknown; readonly identity?: ResolvedIdentity } = {},
  ): Promise<BriefResult> => {
    await recordRejectedWrites(detail.identity, [{
      channel: 'panel',
      reason,
      offending: 'offending' in detail ? detail.offending : input,
      conversationId: (input as { conversationId?: unknown } | null)?.conversationId,
      fieldName: detail.fieldName,
    }]);
    return { ok: false, code, message };
  };

  if (!hasOnlyKeys(input, UPDATE_KEYS) || !isUuid(input.conversationId) || typeof input.fieldName !== 'string') {
    return refuse('invalid_request', 'invalid_request', MESSAGES.invalid);
  }
  const spec = briefFieldSpec(input.fieldName);
  if (!spec) return refuse('unknown_field', 'invalid_request', MESSAGES.invalid, { fieldName: input.fieldName });
  const checked = validateBriefValue(spec, input.value);
  if (!checked.ok) {
    return refuse('invalid_value', 'invalid_value', checked.message, { fieldName: spec.name, offending: input.value });
  }

  const conversationId = input.conversationId as ConversationId;
  // Brief data later reaches agents: KAN-27 consent is required, as for chat.
  const authorized = await authorizeConversation(conversationId, { requireDurability: false, requireTerms: true });
  if (!authorized.ok) {
    // A forged or foreign conversation id (another user's or tenant's) is logged; other access failures are not writes.
    if (authorized.code === 'conversation_unavailable') {
      await refuse('conversation_unavailable', authorized.code, authorized.message, { fieldName: spec.name });
    }
    return authorized;
  }
  const { identity } = authorized;

  const owners = buildDefaultRegistry()
    .getFieldSchemas()
    .filter((schema) => schema.requiredFields.includes(spec.name) || schema.optionalFields.includes(spec.name))
    .map((schema) => schema.agentId);
  if (owners.length === 0) return refuse('unknown_field', 'invalid_request', MESSAGES.invalid, { fieldName: spec.name, identity });

  const delta: FieldDelta = {
    conversationId,
    source: BRIEF_PANEL_SOURCE,
    timestamp: new Date().toISOString(),
    fields: Object.fromEntries(
      owners.map((agentId) => [agentId, { [spec.name]: { value: checked.value, confidence: 1, rawInput: checked.value } }]),
    ),
  };
  try {
    const { rejected } = await getOrchestrator().applyDelta(delta);
    if (rejected.length > 0) {
      // Unreachable while the panel and merge share the catalog rule; refused and logged if they ever drift.
      await recordRejectedWrites(identity, rejected.map((write) => ({
        channel: 'panel' as const,
        reason: write.reason,
        offending: input.value,
        conversationId,
        agentId: write.agentId,
        fieldName: write.fieldName,
      })));
      return { ok: false, code: 'invalid_value', message: MESSAGES.invalid };
    }
    log.info({ conversationId, fieldName: spec.name, owners }, 'brief.field_updated');
    return await currentBrief(conversationId);
  } catch (error) {
    log.error({ conversationId, fieldName: spec.name, err: error }, 'brief.update_failed');
    return { ok: false, code: 'brief_failed', message: MESSAGES.saveFailed };
  }
}

async function currentBrief(conversationId: ConversationId): Promise<BriefResult> {
  const orchestrator = getOrchestrator();
  const [snapshot, states] = await Promise.all([
    orchestrator.getSnapshot(conversationId),
    orchestrator.getDeliverableStates(conversationId),
  ]);
  return { ok: true, fields: briefPanelFields(snapshot), states };
}
