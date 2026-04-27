/**
 * MYPES Platform — State Merge stage
 * ===================================
 *
 * Location: src/orchestrator/merge.ts
 *
 * Pure code. Given a FieldDelta, updates the conversation store's field slots
 * according to CONFIDENCE_THRESHOLDS.
 *
 * Rules:
 *   - confidence >= AUTO_ACCEPT       -> slot becomes 'filled'
 *   - confidence >= STORE_AND_CONFIRM -> slot becomes 'pending_confirmation'
 *   - confidence <  STORE_AND_CONFIRM -> slot left untouched (we will re-ask)
 *
 * Conflict policy (same field already filled):
 *   - If incoming confidence >= existing confidence -> overwrite
 *   - Else -> no-op (we trust the existing stronger signal)
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
  type FieldDelta,
  type FieldSlot,
} from '../contracts';
import type { AgentRegistry } from './agent-registry';
import type { IConversationStore } from './in-memory-store';

export async function mergeFieldDelta(
  delta: FieldDelta,
  store: IConversationStore,
  registry: AgentRegistry,
): Promise<void> {
  const snapshot = await store.get(delta.conversationId);
  if (!snapshot) {
    throw new Error(
      `Cannot merge into unknown conversation: ${delta.conversationId}. ` +
        `Call store.getOrCreate() before the first applyDelta.`,
    );
  }

  for (const [agentId, fields] of Object.entries(delta.fields)) {
    // Validate agent is registered — deltas for unknown agents are dropped.
    let agentKnown = true;
    try {
      registry.get(agentId);
    } catch {
      agentKnown = false;
    }
    if (!agentKnown) continue;

    const fieldSchemas = registry.getFieldSchemas().find((s) => s.agentId === agentId);
    if (!fieldSchemas) continue;

    for (const [fieldName, incoming] of Object.entries(fields)) {
      if (incoming.confidence < CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM) {
        continue; // too low — we'll re-ask explicitly
      }

      const isRequired = fieldSchemas.requiredFields.includes(fieldName);
      const isOptional = fieldSchemas.optionalFields.includes(fieldName);
      if (!isRequired && !isOptional) continue; // unknown field for this agent

      const currentSlot =
        snapshot.agentStates[agentId]?.[isRequired ? 'requiredFields' : 'optionalFields']?.[
          fieldName
        ];

      // Conflict: if existing is filled with higher confidence, keep it.
      if (
        currentSlot &&
        currentSlot.status !== 'empty' &&
        currentSlot.confidence > incoming.confidence
      ) {
        continue;
      }

      const nextSlot: FieldSlot =
        incoming.confidence >= CONFIDENCE_THRESHOLDS.AUTO_ACCEPT
          ? { status: 'filled', value: incoming.value, confidence: incoming.confidence }
          : { status: 'pending_confirmation', value: incoming.value, confidence: incoming.confidence };

      await store.updateFieldSlot(
        delta.conversationId,
        agentId,
        fieldName,
        isRequired,
        nextSlot,
      );
    }
  }

  // Intents are merged separately (selection, iteration, cancel, reset).
  if (delta.intents) {
    for (const intent of delta.intents) {
      switch (intent.kind) {
        case 'select_deliverable': {
          // The merge stage records the selection. Figuring out WHICH agent
          // the deliverable belongs to is a storage lookup; for now, callers
          // include the agentId context via other means (future: enrich the
          // intent). We no-op here to keep the harness small.
          break;
        }
        case 'reset_field': {
          const schemas = registry.getFieldSchemas().find((s) => s.agentId === intent.agentId);
          if (!schemas) break;
          const isRequired = schemas.requiredFields.includes(intent.fieldName);
          await store.updateFieldSlot(
            delta.conversationId,
            intent.agentId,
            intent.fieldName,
            isRequired,
            { status: 'empty' },
          );
          break;
        }
        case 'request_iteration':
        case 'cancel_task':
          // Handled by the orchestrator's dispatch logic, not the merge stage.
          break;
      }
    }
  }
}