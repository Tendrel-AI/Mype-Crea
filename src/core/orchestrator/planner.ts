/**
 * MYPES Platform — Planner
 * =========================
 *
 * Location: src/orchestrator/planner.ts
 *
 * THIS IS THE TESTABLE CORE OF THE THESIS CONTRIBUTION.
 *
 * Given a ConversationSnapshot, returns the next PlannerDecision.
 * Deterministic. Pure code. No LLMs. No I/O. No side effects.
 *
 * The function's responsibility is to answer:
 *   "Given what we know about this conversation's state, what should
 *    the orchestrator do next?"
 *
 * Decision ordering (first match wins):
 *   1. If any agent has a dispatched-but-unsettled task -> awaiting_dispatch
 *   2. If any agent has a just-settled task not yet announced -> announce_*
 *      (handled by the orchestrator core, not here — see orchestrator-core.ts)
 *   3. If any agent has a field in pending_confirmation -> confirm_field
 *   4. If any agent has an empty required field (ordered by displayOrder)
 *      -> request_field
 *   5. If any agent is ready to dispatch (all required fields filled,
 *      not yet dispatched) -> announce_dispatch (orchestrator emits this
 *      AFTER it actually dispatches; planner returns 'idle: awaiting_dispatch')
 *   6. Otherwise -> idle
 *
 * See also:
 *   - contracts.ts   (PlannerDecision variants, CONFIDENCE_THRESHOLDS)
 *   - merge.ts       (runs before the Planner, updates the snapshot the
 *                     planner reads)
 *   - .claude/skills/mypes-architecture/SKILL.md  (rule 2: no LLMs in Planner)
 */

import type {
  AgentId,
  ConversationSnapshot,
  PlannerDecision,
} from '../contracts';
import type { AgentRegistry } from './agent-registry';

export function planNextDecision(
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
): PlannerDecision {
  const orderedAgents = [...registry.getFieldSchemas()].sort(
    (a, b) => a.displayOrder - b.displayOrder,
  );

  // Step 1: are we waiting on a dispatched agent to settle?
  for (const schema of orderedAgents) {
    const agentState = snapshot.agentStates[schema.agentId];
    if (!agentState) continue;
    if (agentState.lastDispatchedTaskId) {
      // The orchestrator clears lastDispatchedTaskId (or advances iteration)
      // when it has surfaced the completion. If it's still set, we're waiting
      // or the completion hasn't been announced yet.
      return { kind: 'idle', reason: 'awaiting_dispatch' };
    }
  }

  // Step 2: any pending-confirmation fields?
  for (const schema of orderedAgents) {
    const agentState = snapshot.agentStates[schema.agentId];
    if (!agentState) continue;
    for (const fieldName of schema.requiredFields) {
      const slot = agentState.requiredFields[fieldName];
      if (slot?.status === 'pending_confirmation') {
        return {
          kind: 'confirm_field',
          agentId: schema.agentId,
          fieldName,
          pendingValue: slot.value,
          reason: 'low_confidence',
        };
      }
    }
  }

  // Step 3: any empty required field? Ask about the first one in agent-order,
  // then field-order (per the card's requirements array).
  for (const schema of orderedAgents) {
    const agentState = snapshot.agentStates[schema.agentId];
    if (!agentState) continue;
    for (const fieldName of schema.requiredFields) {
      const slot = agentState.requiredFields[fieldName];
      if (!slot || slot.status === 'empty') {
        return {
          kind: 'request_field',
          agentId: schema.agentId,
          fieldName,
          promptHint: registry.getPromptHint(schema.agentId, fieldName),
        };
      }
    }
  }

  // Step 4: any agent fully satisfied and not yet dispatched?
  const readyToDispatch = findAgentReadyToDispatch(snapshot, orderedAgents);
  if (readyToDispatch) {
    // The orchestrator will call dispatch then emit announce_dispatch.
    // From the planner's point of view, we tell it "go do that".
    return { kind: 'idle', reason: 'awaiting_dispatch' };
  }

  // Step 5: all agents have deliverables. We're done until the user does something.
  return { kind: 'idle', reason: 'all_complete' };
}

/**
 * Exposed so the orchestrator core can answer "which agent, if any, should
 * I dispatch right now?" after a merge.
 */
export function findAgentReadyToDispatch(
  snapshot: ConversationSnapshot,
  orderedAgents: ReadonlyArray<{ readonly agentId: AgentId; readonly requiredFields: ReadonlyArray<string> }>,
): AgentId | null {
  for (const schema of orderedAgents) {
    const agentState = snapshot.agentStates[schema.agentId];
    if (!agentState) continue;
    if (agentState.lastDispatchedTaskId) continue; // already dispatched something

    const allRequiredFilled = schema.requiredFields.every(
      (f) => agentState.requiredFields[f]?.status === 'filled',
    );
    if (allRequiredFilled && schema.requiredFields.length > 0) {
      return schema.agentId;
    }
  }
  return null;
}