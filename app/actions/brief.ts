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
import { briefFieldSpec, briefFromSnapshot, validateBriefValue, type BriefFieldView } from '../../src/core/brief';
import type { ConversationId, DeliverableStateView, FieldDelta } from '../../src/core/contracts';
import { loggerFor } from '../../src/services/logger';
import { authorizeConversation, isUuid, type AccessFailureCode } from './conversation-access';

const log = loggerFor('controller.brief');

/** `FieldDelta.source` of panel edits. Audit/display only (the core never branches on it). */
const BRIEF_PANEL_SOURCE = 'brief-panel';

/** A brief field as the panel shows it: which channel wrote the accepted value. */
export type BriefPanelField = Omit<BriefFieldView, 'source'> & { readonly source: 'chat' | 'panel' | null };

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

/** Set one brief field from the panel, through the same merge path as chat. */
export async function updateBriefFieldAction(input: {
  readonly conversationId: string;
  readonly fieldName: string;
  readonly value: string;
}): Promise<BriefResult> {
  if (!isUuid(input?.conversationId)) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
  const spec = briefFieldSpec(String(input.fieldName));
  if (!spec) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
  const checked = validateBriefValue(spec, input.value);
  if (!checked.ok) return { ok: false, code: 'invalid_value', message: checked.message };

  const conversationId = input.conversationId as ConversationId;
  // Brief data later reaches agents: KAN-27 consent is required, as for chat.
  const authorized = await authorizeConversation(conversationId, { requireDurability: false, requireTerms: true });
  if (!authorized.ok) return authorized;

  const owners = buildDefaultRegistry()
    .getFieldSchemas()
    .filter((schema) => schema.requiredFields.includes(spec.name) || schema.optionalFields.includes(spec.name))
    .map((schema) => schema.agentId);
  if (owners.length === 0) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };

  const delta: FieldDelta = {
    conversationId,
    source: BRIEF_PANEL_SOURCE,
    timestamp: new Date().toISOString(),
    fields: Object.fromEntries(
      owners.map((agentId) => [agentId, { [spec.name]: { value: checked.value, confidence: 1, rawInput: checked.value } }]),
    ),
  };
  try {
    await getOrchestrator().applyDelta(delta);
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
  const fields = briefFromSnapshot(snapshot).map((field) => ({
    ...field,
    // shortcut: every non-panel source is the chat today; name new input adapters here when they exist.
    source: field.source === null ? null : field.source === BRIEF_PANEL_SOURCE ? ('panel' as const) : ('chat' as const),
  }));
  return { ok: true, fields, states };
}
