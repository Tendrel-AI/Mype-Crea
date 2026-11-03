/**
 * MYPES Platform — State Merge stage
 * ===================================
 *
 * Location: src/core/orchestrator/merge.ts
 *
 * Pure code. Given a FieldDelta, updates the conversation store's field slots
 * according to CONFIDENCE_THRESHOLDS.
 *
 * Rules:
 *   - confidence >= AUTO_ACCEPT       -> slot becomes 'filled'
 *   - confidence >= STORE_AND_CONFIRM -> slot becomes 'pending_confirmation'
 *   - confidence <  STORE_AND_CONFIRM -> slot left untouched (we will re-ask)
 *
 * Conflict policy (same field already filled or pending):
 *   - If incoming confidence >= existing confidence -> overwrite
 *   - Else -> no-op (we trust the existing stronger signal)
 *   - Unless the same delta reset that field (see order below): a reset slot
 *     is empty, so the incoming value has nothing to conflict with.
 *
 * Application order within one delta (deterministic, independent of the
 * order of `fields` vs `intents` in the payload):
 *   1. `reset_field` intents, in delta order. Each one empties its slot.
 *   2. Field values, in delta order, under the rules above.
 *   3. Every other intent (`select_deliverable`, `request_iteration`,
 *      `cancel_task`). None of them touches field slots, so their position
 *      after the values changes nothing they do today.
 * Resets go first so that `reset_field(F)` + `F = X` in one delta means
 * "replace F with X", whatever X's confidence is relative to the old value.
 * A reset with no value (or with a value below STORE_AND_CONFIRM) leaves F
 * empty, which is what a reset alone means.
 *
 * Unknown agents and unknown fields are rejected the same way for values and
 * for `reset_field`: no store write, and the rejection is reported in the
 * returned `MergeResult` and the `merger.output` log.
 *
 * KAN-26: a value for a brief catalog field (`../brief.ts`) is normalized and
 * validated by `validateBriefValue` before it is stored, whatever channel
 * produced it; an invalid value is `rejected_invalid_value` (no write). The
 * slot records `delta.source` for provenance; nothing here branches on it.
 *
 * This function does NOT dispatch agents. Dispatch is the orchestrator's
 * responsibility, triggered AFTER merge completes.
 *
 * See also:
 *   - contracts.ts   (FieldDelta, FieldSlot, CONFIDENCE_THRESHOLDS)
 *   - planner.ts     (runs after merge to decide next action)
 */

import {
  CONFIDENCE_THRESHOLDS,
  type AgentRequirementState,
  type FieldDelta,
  type FieldSlot,
  type UserIntent,
} from '../contracts';
import { loggerFor } from '../../services/logger';
import { briefFieldSpec, validateBriefValue } from '../brief';
import type { AgentRegistry } from './agent-registry';
import type { AgentFieldSchema, IConversationStore } from './in-memory-store';

const log = loggerFor('orchestrator.merge');

export type FieldOutcome =
  | 'filled'
  | 'pending_confirmation'
  | 'rejected_low_confidence'
  | 'rejected_unknown_agent'
  | 'rejected_unknown_field'
  | 'rejected_invalid_value'
  | 'conflict_kept_existing'
  | 'stale_confirmation';

export type IntentOutcome =
  | 'reset'
  | 'rejected_unknown_agent'
  | 'rejected_unknown_field'
  | 'noop'
  | 'deferred_to_dispatch'
  | 'stale_confirmation';

export interface MergeFieldOutcome {
  readonly agentId: string;
  readonly fieldName: string;
  readonly outcome: FieldOutcome;
  readonly confidence?: number;
}

export interface MergeIntentOutcome {
  readonly kind: UserIntent['kind'];
  readonly agentId?: string;
  readonly fieldName?: string;
  readonly outcome: IntentOutcome;
}

/** What one merge did. Callers may ignore it; it exists for audit and tests. */
export interface MergeResult {
  readonly mutationsApplied: number;
  readonly fieldOutcomes: ReadonlyArray<MergeFieldOutcome>;
  readonly intentOutcomes: ReadonlyArray<MergeIntentOutcome>;
}

type FieldResolution =
  | { readonly kind: 'unknown_agent' }
  | { readonly kind: 'unknown_field' }
  | { readonly kind: 'known'; readonly isRequired: boolean };

export async function mergeFieldDelta(
  delta: FieldDelta,
  store: IConversationStore,
  registry: AgentRegistry,
): Promise<MergeResult> {
  const fieldsCount = Object.values(delta.fields).reduce(
    (acc, fields) => acc + Object.keys(fields).length,
    0,
  );
  const intents = delta.intents ?? [];
  const intentsCount = intents.length;
  const child = log.child({
    op: 'mergeFieldDelta',
    conversationId: delta.conversationId,
    source: delta.source,
  });

  const incomingFields = Object.fromEntries(
    Object.entries(delta.fields).map(([agentId, fields]) => [
      agentId,
      Object.fromEntries(
        Object.entries(fields).map(([name, v]) => [
          name,
          { confidence: v.confidence, valuePreview: previewValue(v.value) },
        ]),
      ),
    ]),
  );
  child.info(
    {
      contract: 'FieldDelta',
      timestamp: delta.timestamp,
      fieldsCount,
      intentsCount,
      fields: incomingFields,
      intents: intents.map((i) => ({ kind: i.kind, agentId: 'agentId' in i ? i.agentId : undefined })),
    },
    'merger.input',
  );
  child.info({ fieldsCount, intentsCount }, 'merge.delta.received');

  const fieldOutcomes: MergeFieldOutcome[] = [];
  const intentOutcomes: MergeIntentOutcome[] = [];

  const snapshot = await store.get(delta.conversationId);
  if (!snapshot) {
    throw new Error(
      `Cannot merge into unknown conversation: ${delta.conversationId}. ` +
        `Call store.getOrCreate() before the first applyDelta.`,
    );
  }

  const schemas = registry.getFieldSchemas();
  let mutationsApplied = 0;

  // -------------------------------------------------------------------------
  // Phase 1: reset_field intents. Slots reset here count as empty in phase 2.
  // -------------------------------------------------------------------------
  const resetSlots = new Set<string>();
  for (const intent of intents) {
    if (intent.kind !== 'reset_field') continue;
    const { agentId, fieldName } = intent;
    const resolution = resolveField(registry, schemas, agentId, fieldName);
    if (resolution.kind !== 'known') {
      const outcome =
        resolution.kind === 'unknown_agent' ? 'rejected_unknown_agent' : 'rejected_unknown_field';
      intentOutcomes.push({ kind: intent.kind, agentId, fieldName, outcome });
      child.debug({ kind: intent.kind, agentId, fieldName, outcome }, 'merge.intent.rejected');
      continue;
    }
    if (isStale(intent, snapshot.agentStates[agentId], fieldName, resolution.isRequired)) {
      intentOutcomes.push({ kind: intent.kind, agentId, fieldName, outcome: 'stale_confirmation' });
      child.debug({ kind: intent.kind, agentId, fieldName }, 'merge.intent.stale_confirmation');
      continue;
    }
    await store.updateFieldSlot(
      delta.conversationId,
      agentId,
      fieldName,
      resolution.isRequired,
      { status: 'empty' },
    );
    mutationsApplied++;
    resetSlots.add(slotKey(agentId, fieldName));
    intentOutcomes.push({ kind: intent.kind, agentId, fieldName, outcome: 'reset' });
    child.debug({ kind: intent.kind, agentId, fieldName }, 'merge.intent.processed');
  }

  // -------------------------------------------------------------------------
  // Phase 2: field values.
  // -------------------------------------------------------------------------
  for (const [agentId, fields] of Object.entries(delta.fields)) {
    for (const [fieldName, incoming] of Object.entries(fields)) {
      const resolution = resolveField(registry, schemas, agentId, fieldName);

      // Deltas for unknown agents are dropped before any other check.
      if (resolution.kind === 'unknown_agent') {
        fieldOutcomes.push({ agentId, fieldName, outcome: 'rejected_unknown_agent' });
        child.debug(
          { agentId, fieldName, outcome: 'rejected_unknown_agent' satisfies FieldOutcome },
          'merge.field.rejected',
        );
        continue;
      }

      if (incoming.confidence < CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM) {
        fieldOutcomes.push({ agentId, fieldName, outcome: 'rejected_low_confidence', confidence: incoming.confidence });
        child.debug(
          {
            agentId,
            fieldName,
            confidence: incoming.confidence,
            outcome: 'rejected_low_confidence' satisfies FieldOutcome,
          },
          'merge.field.rejected',
        );
        continue; // too low — we'll re-ask explicitly
      }

      if (resolution.kind === 'unknown_field') {
        fieldOutcomes.push({ agentId, fieldName, outcome: 'rejected_unknown_field' });
        child.debug(
          {
            agentId,
            fieldName,
            outcome: 'rejected_unknown_field' satisfies FieldOutcome,
          },
          'merge.field.rejected',
        );
        continue; // unknown field for this agent
      }

      // shortcut: fields outside the brief catalog are stored unvalidated until KAN-44 rejects them.
      const spec = briefFieldSpec(fieldName);
      const checked = spec ? validateBriefValue(spec, incoming.value) : { ok: true as const, value: incoming.value };
      if (!checked.ok) {
        fieldOutcomes.push({ agentId, fieldName, outcome: 'rejected_invalid_value', confidence: incoming.confidence });
        child.debug(
          { agentId, fieldName, outcome: 'rejected_invalid_value' satisfies FieldOutcome },
          'merge.field.rejected',
        );
        continue;
      }

      const { isRequired } = resolution;
      if (isStale(incoming, snapshot.agentStates[agentId], fieldName, isRequired)) {
        fieldOutcomes.push({ agentId, fieldName, outcome: 'stale_confirmation', confidence: incoming.confidence });
        child.debug({ agentId, fieldName, outcome: 'stale_confirmation' satisfies FieldOutcome }, 'merge.field.rejected');
        continue;
      }
      // A slot reset in phase 1 is empty now, whatever the snapshot read said.
      const currentSlot = resetSlots.has(slotKey(agentId, fieldName))
        ? undefined
        : snapshot.agentStates[agentId]?.[isRequired ? 'requiredFields' : 'optionalFields']?.[
            fieldName
          ];

      // Conflict: if existing is filled with higher confidence, keep it.
      if (
        currentSlot &&
        currentSlot.status !== 'empty' &&
        currentSlot.confidence > incoming.confidence
      ) {
        fieldOutcomes.push({ agentId, fieldName, outcome: 'conflict_kept_existing', confidence: incoming.confidence });
        child.debug(
          {
            agentId,
            fieldName,
            confidence: incoming.confidence,
            existingConfidence: currentSlot.confidence,
            outcome: 'conflict_kept_existing' satisfies FieldOutcome,
          },
          'merge.field.conflict',
        );
        continue;
      }

      const nextStatus: 'filled' | 'pending_confirmation' =
        incoming.confidence >= CONFIDENCE_THRESHOLDS.AUTO_ACCEPT
          ? 'filled'
          : 'pending_confirmation';
      const nextSlot: FieldSlot = {
        status: nextStatus,
        value: checked.value,
        confidence: incoming.confidence,
        source: delta.source,
      };

      await store.updateFieldSlot(
        delta.conversationId,
        agentId,
        fieldName,
        isRequired,
        nextSlot,
      );
      mutationsApplied++;
      fieldOutcomes.push({ agentId, fieldName, outcome: nextStatus, confidence: incoming.confidence });
      child.debug(
        {
          agentId,
          fieldName,
          confidence: incoming.confidence,
          outcome: nextStatus satisfies FieldOutcome,
        },
        'merge.field.applied',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: every other intent. None of these writes field slots.
  // -------------------------------------------------------------------------
  for (const intent of intents) {
    switch (intent.kind) {
      case 'reset_field':
        break; // applied in phase 1
      case 'select_deliverable': {
        // The merge stage records the selection. Figuring out WHICH agent
        // the deliverable belongs to is a storage lookup; for now, callers
        // include the agentId context via other means (future: enrich the
        // intent). We no-op here to keep the harness small.
        intentOutcomes.push({ kind: intent.kind, outcome: 'noop' });
        child.debug({ kind: intent.kind }, 'merge.intent.processed');
        break;
      }
      case 'request_iteration':
      case 'cancel_task':
        // Handled by the orchestrator's dispatch logic, not the merge stage.
        intentOutcomes.push({
          kind: intent.kind,
          ...('agentId' in intent ? { agentId: intent.agentId } : {}),
          outcome: 'deferred_to_dispatch',
        });
        child.debug({ kind: intent.kind }, 'merge.intent.deferred_to_dispatch');
        break;
    }
  }

  child.info({ mutationsApplied }, 'merge.delta.complete');
  child.info(
    {
      mutationsApplied,
      outcomes: fieldOutcomes,
      intentOutcomes,
      intentsProcessed: intentsCount,
    },
    'merger.output',
  );
  return { mutationsApplied, fieldOutcomes, intentOutcomes };
}

/**
 * Classify `agentId.fieldName` against the registry: unknown agent, unknown
 * field for that agent, or a declared required/optional field. Shared by field
 * values and `reset_field` so both reject the same inputs.
 */
function resolveField(
  registry: AgentRegistry,
  schemas: ReadonlyArray<AgentFieldSchema>,
  agentId: string,
  fieldName: string,
): FieldResolution {
  try {
    registry.get(agentId);
  } catch {
    return { kind: 'unknown_agent' };
  }
  const agentSchemas = schemas.find((s) => s.agentId === agentId);
  if (!agentSchemas) return { kind: 'unknown_agent' };
  if (agentSchemas.requiredFields.includes(fieldName)) return { kind: 'known', isRequired: true };
  if (agentSchemas.optionalFields.includes(fieldName)) return { kind: 'known', isRequired: false };
  return { kind: 'unknown_field' };
}

function slotKey(agentId: string, fieldName: string): string {
  return `${agentId}\u0000${fieldName}`;
}

function previewValue(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

/**
 * True when a confirmation answer no longer applies: it names the pending
 * value it answers, and the slot (as read before this delta) no longer holds
 * that value as pending — e.g. the user set the field in the panel since.
 */
function isStale(
  input: { readonly expectedPendingValue?: unknown },
  state: AgentRequirementState | undefined,
  fieldName: string,
  isRequired: boolean,
): boolean {
  if (input.expectedPendingValue === undefined) return false;
  const slot = state?.[isRequired ? 'requiredFields' : 'optionalFields']?.[fieldName];
  return (
    slot?.status !== 'pending_confirmation' ||
    JSON.stringify(slot.value) !== JSON.stringify(input.expectedPendingValue)
  );
}
