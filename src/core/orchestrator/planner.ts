/**
 * MYPES Platform — Planner
 * =========================
 *
 * Location: src/core/orchestrator/planner.ts
 *
 * THIS IS THE TESTABLE CORE OF THE THESIS CONTRIBUTION.
 *
 * Given a ConversationSnapshot, returns the Planner's next ordered plan as
 * a `ReadonlyArray<PlannerDecision>`. Deterministic. Pure code. No LLMs.
 * No I/O. No side effects.
 *
 * The planner is agent-agnostic: it does NOT know which agent comes "first."
 * Its only inputs are the agent cards (via the registry) and the slot
 * statuses (via the snapshot). Decisions are made by querying the data.
 *
 * Decision rules (first match wins; one match produces the entire plan):
 *
 *   1. Any slot (required or optional) in `pending_confirmation`
 *      -> `[confirm_field]` (solo; never batched with anything else, since
 *         confirms are y/n turns). KAN-26: an ambiguous optional brief value
 *         (rubro, producto, …) is confirmed too before it counts.
 *
 *   2. There exists a "focus agent" — the lex-first registered agent that
 *      (a) has at least one missing required slot, (b) is not currently
 *      in-flight (`lastDispatchedTaskId` unset), and (c) has not been
 *      dispatched before in this conversation (`iterationCount === 0`)
 *      -> `[request_fields]` carrying the lex-first up to
 *         `MAX_FIELD_BATCH_SIZE` (or the card's own `askBatchSize`) missing
 *         required field names from that agent.
 *      When the caller passes derived deliverable states, an agent whose
 *      deliverable is not `blocked` (approved, own-provided, generating,
 *      in review, failed) or is inherited read-only from the brand (product
 *      conversation) is never asked: its brief would not be used.
 *
 *   3. A deliverable is ready to generate — lex-first agent whose derived
 *      state is `enabled` (KAN-64: preconditions met, nothing generated, no
 *      task in flight)
 *      -> `[offer_generation]`. The planner never dispatches and neither
 *         does the core after a merge: generation starts only through a
 *         typed «Generar» command (`DeliverableCommandPort`). This decision
 *         only lets the Responder point the user at the button.
 *
 *   4. A non-inherited deliverable is `failed`, `in_review` or `generating`
 *      (KAN-91; only with `context.deliverableStates`) — the user has a panel
 *      action to take or to wait for. Priority failed > in_review >
 *      generating, then lex `agentId`.
 *      -> `[report_deliverable_status]` carrying that view's allowedCommands.
 *
 *   5. Otherwise — every agent is filled and generated (or waiting for an
 *      upstream approval), and there is nothing to ask.
 *      -> `[announce_all_complete]`.
 *
 * Rules 3 and 4 read the per-deliverable states the caller derived with the pure
 * `deriveDeliverableStates` (passed in `context.deliverableStates`). Without
 * that context (unit tests, legacy callers) it falls back to the snapshot
 * predicate `findAgentReadyToGenerate`. Both inputs are plain data: same
 * snapshot + same states → same plan.
 *
 * `announce_dispatch` and `announce_completion` decisions are NOT produced
 * here. The orchestrator core queues them on dispatch / settlement and
 * splices them onto the front of this plan inside `getNextDecision` so the
 * Responder can render "ya empezó X" + "y para Y, cuéntame…" in a single
 * turn. The planner stays pure: same snapshot → same plan.
 *
 * Tiebreakers are deterministic and lexicographic — by `agentId` first
 * (stable focus agent), then by `fieldName` within an agent (so a shared
 * field like `business_name` lands at the top of the batch and the merge
 * stage's fan-out unblocks every owner with one answer). Ordering is
 * never seeded from registration order or `mypes:ui.displayOrder`; ordering
 * of agents in the wizard is a UI concern, not an orchestrator concern.
 *
 * Logging is observability, not control flow: the same input still produces
 * the same plan regardless of log level. Per the architecture skill rule 2,
 * this preserves planner purity.
 *
 * See also:
 *   - contracts.ts   (PlannerDecision variants, MAX_FIELD_BATCH_SIZE,
 *                     CONFIDENCE_THRESHOLDS)
 *   - merge.ts       (runs before the Planner, updates the snapshot the
 *                     planner reads)
 *   - orchestrator-core.ts (queues `announce_dispatch` /
 *                     `announce_completion` and composes the final plan)
 *   - docs/agents/architecture.md
 */

import {
  MAX_FIELD_BATCH_SIZE,
  type AgentId,
  type ConversationSnapshot,
  type DeliverableStateView,
  type PlannerDecision,
  type RequestFieldEntry,
} from '../contracts';
import { loggerFor } from '../../services/logger';
import type { AgentRegistry } from './agent-registry';

const log = loggerFor('orchestrator.planner');

/** Optional, already-derived inputs. Plain data; reading them keeps the planner pure. */
export interface PlannerContext {
  /** Output of `deriveDeliverableStates` for the same snapshot. */
  readonly deliverableStates?: ReadonlyArray<
    Pick<DeliverableStateView, 'agentId' | 'deliverableKind' | 'state' | 'allowedCommands'> & Partial<Pick<DeliverableStateView, 'inheritedFromBrand'>>
  >;
}

export function planNextDecision(
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
  context: PlannerContext = {},
): ReadonlyArray<PlannerDecision> {
  const child = log.child({
    op: 'planNextDecision',
    conversationId: snapshot.conversationId,
    tenantId: snapshot.tenantId,
  });

  const decide = (plan: ReadonlyArray<PlannerDecision>, reason: string): ReadonlyArray<PlannerDecision> => {
    child.info(
      {
        kinds: plan.map((d) => d.kind),
        reason,
      },
      'planner.decision.chosen',
    );
    child.info(
      { contract: 'PlannerDecision[]', plan, reason },
      'planner.output',
    );
    return plan;
  };

  const schemas = registry.getFieldSchemas();

  const requirements = schemas.map((schema) => {
    const agentState = snapshot.agentStates[schema.agentId];
    const summarize = (fieldNames: ReadonlyArray<string>) => {
      const out: Record<string, string> = {};
      for (const name of fieldNames) {
        const slot = agentState?.requiredFields[name] ?? agentState?.optionalFields[name];
        out[name] = slot?.status ?? 'empty';
      }
      return out;
    };
    const required = summarize(schema.requiredFields);
    const optional = summarize(schema.optionalFields);
    const filledRequired = schema.requiredFields.filter(
      (f) => agentState?.requiredFields[f]?.status === 'filled',
    ).length;
    return {
      agentId: schema.agentId,
      required,
      optional,
      requiredSatisfied: `${filledRequired}/${schema.requiredFields.length}`,
      dispatched: Boolean(agentState?.lastDispatchedTaskId),
      iterationCount: agentState?.iterationCount ?? 0,
    };
  });

  child.info(
    { agentsTracked: schemas.length, requirements },
    'planner.evaluate.start',
  );
  child.info(
    {
      contract: 'ConversationSnapshot',
      agentsTracked: schemas.length,
      requirements,
    },
    'planner.input',
  );

  // Rule 1: any pending_confirmation (required or optional)? Pick the lex-first (agentId, fieldName)
  // pair so the same field gets confirmed once even if multiple agents own it.
  const pending = collectPendingConfirmations(snapshot, schemas);
  if (pending.length > 0) {
    pending.sort(byAgentThenField);
    const head = pending[0];
    return decide(
      [
        {
          kind: 'confirm_field',
          agentId: head.agentId,
          fieldName: head.fieldName,
          pendingValue: head.value,
          reason: 'low_confidence',
        },
      ],
      'pending_confirmation',
    );
  }

  // Rule 2: pick a focus agent and batch up to MAX_FIELD_BATCH_SIZE missing
  // required fields from it. Stays on one agent per turn so the user is
  // answering questions about a single concern at a time.
  const focusAgentId = pickFocusAgent(snapshot, schemas, context);
  if (focusAgentId) {
    const schema = schemas.find((s) => s.agentId === focusAgentId)!;
    const agentState = snapshot.agentStates[focusAgentId];
    const missing = schema.requiredFields
      .filter((f) => {
        const slot = agentState?.requiredFields[f];
        return !slot || slot.status === 'empty';
      })
      .sort()
      .slice(0, schema.askBatchSize ?? MAX_FIELD_BATCH_SIZE);

    const fields: RequestFieldEntry[] = missing.map((fieldName) => ({
      fieldName,
      promptHint: registry.getPromptHint(focusAgentId, fieldName),
    }));

    return decide(
      [{ kind: 'request_fields', agentId: focusAgentId, fields }],
      'focus_agent_request_fields',
    );
  }

  // Rule 3: a deliverable is ready — offer the «Generar» button. Never
  // dispatches; generation is a typed command (KAN-64 Option B).
  const offer = pickGenerationOffer(snapshot, registry, context);
  if (offer) {
    return decide(
      [{ kind: 'offer_generation', agentId: offer.agentId, deliverableKind: offer.deliverableKind }],
      'offer_generation',
    );
  }

  // Rule 4 (KAN-91): a deliverable needs the user's panel action or is in flight.
  const status = pickStatusReport(context);
  if (status) {
    return decide(
      [{
        kind: 'report_deliverable_status',
        agentId: status.agentId,
        deliverableKind: status.deliverableKind,
        state: status.state as 'generating' | 'in_review' | 'failed',
        allowedCommands: status.allowedCommands,
      }],
      'report_deliverable_status',
    );
  }

  // Rule 5: nothing pending, no focus agent, nothing to offer or report.
  return decide([{ kind: 'announce_all_complete' }], 'all_complete');
}

function pickGenerationOffer(
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
  context: PlannerContext,
): { readonly agentId: AgentId; readonly deliverableKind: string } | null {
  if (context.deliverableStates) {
    const enabled = context.deliverableStates
      .filter((view) => view.state === 'enabled')
      .filter((view) => !snapshot.agentStates[view.agentId]?.lastDispatchedTaskId)
      .map((view) => ({ agentId: view.agentId, deliverableKind: view.deliverableKind }))
      .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
    return enabled[0] ?? null;
  }
  const agentId = findAgentReadyToGenerate(snapshot, registry.getFieldSchemas());
  if (!agentId) return null;
  const spec = registry.getDeliverableSpecs().find((s) => s.agentId === agentId);
  return { agentId, deliverableKind: spec?.deliverableKind ?? agentId };
}

const STATUS_PRIORITY: Readonly<Record<string, number>> = { failed: 0, in_review: 1, generating: 2 };

function pickStatusReport(context: PlannerContext) {
  const candidates = (context.deliverableStates ?? [])
    .filter((v) => v.state in STATUS_PRIORITY && !v.inheritedFromBrand)
    .sort((a, b) =>
      STATUS_PRIORITY[a.state] - STATUS_PRIORITY[b.state] ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return candidates[0] ?? null;
}

/**
 * Snapshot-only fallback for Rule 3: any agent whose required slots are all
 * `filled` and that has never been dispatched in this conversation.
 * Lex-tiebreak by `agentId` for stable output.
 *
 * Eligibility:
 *   - skip agents with no required fields (nothing to gate on)
 *   - skip agents currently in flight (`lastDispatchedTaskId` set)
 *   - skip agents that have already been dispatched at least once
 *     (`iterationCount > 0`)
 *
 * KAN-28: this used to be `findAgentReadyToDispatch`, which the core called
 * after every merge to auto-dispatch. Nothing dispatches from it anymore; it
 * only decides whether to *offer* «Generar».
 */
export function findAgentReadyToGenerate(
  snapshot: ConversationSnapshot,
  schemas: ReadonlyArray<{ readonly agentId: AgentId; readonly requiredFields: ReadonlyArray<string> }>,
): AgentId | null {
  const candidates: AgentId[] = [];
  for (const schema of schemas) {
    if (schema.requiredFields.length === 0) continue;
    const agentState = snapshot.agentStates[schema.agentId];
    if (!agentState) continue;
    if (agentState.lastDispatchedTaskId) continue;
    if (agentState.iterationCount > 0) continue;
    const allRequiredFilled = schema.requiredFields.every(
      (f) => agentState.requiredFields[f]?.status === 'filled',
    );
    if (allRequiredFilled) candidates.push(schema.agentId);
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[0];
}

/**
 * Pick the agent the conversation should focus on this turn. Lex-first by
 * agentId among agents that:
 *   - have at least one missing required field, AND
 *   - are not currently in-flight, AND
 *   - have not been dispatched yet (`iterationCount === 0`).
 *
 * Returns null when no agent qualifies (every required field is filled
 * across the board, or every agent with missing fields is already dispatched
 * or in flight).
 */
function pickFocusAgent(
  snapshot: ConversationSnapshot,
  schemas: ReadonlyArray<{ readonly agentId: AgentId; readonly requiredFields: ReadonlyArray<string> }>,
  context: PlannerContext,
): AgentId | null {
  const candidates: AgentId[] = [];
  for (const schema of schemas) {
    if (schema.requiredFields.length === 0) continue;
    const agentState = snapshot.agentStates[schema.agentId];
    if (agentState?.lastDispatchedTaskId) continue;
    if ((agentState?.iterationCount ?? 0) > 0) continue;
    // Only a `blocked`, non-inherited deliverable still needs its brief asked.
    const view = context.deliverableStates?.find((v) => v.agentId === schema.agentId);
    if (view && (view.state !== 'blocked' || view.inheritedFromBrand)) continue;
    const hasMissing = schema.requiredFields.some((f) => {
      const slot = agentState?.requiredFields[f];
      return !slot || slot.status === 'empty';
    });
    if (hasMissing) candidates.push(schema.agentId);
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[0];
}

interface FieldRef {
  readonly agentId: AgentId;
  readonly fieldName: string;
  readonly value?: unknown;
}

function collectPendingConfirmations(
  snapshot: ConversationSnapshot,
  schemas: ReadonlyArray<{
    readonly agentId: AgentId;
    readonly requiredFields: ReadonlyArray<string>;
    readonly optionalFields: ReadonlyArray<string>;
  }>,
): FieldRef[] {
  const out: FieldRef[] = [];
  for (const schema of schemas) {
    const agentState = snapshot.agentStates[schema.agentId];
    if (!agentState) continue;
    for (const [fieldNames, slots] of [
      [schema.requiredFields, agentState.requiredFields],
      [schema.optionalFields, agentState.optionalFields],
    ] as const) {
      for (const fieldName of fieldNames) {
        const slot = slots[fieldName];
        if (slot?.status === 'pending_confirmation') {
          out.push({ agentId: schema.agentId, fieldName, value: slot.value });
        }
      }
    }
  }
  return out;
}

function byAgentThenField(a: FieldRef, b: FieldRef): number {
  if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
  if (a.fieldName === b.fieldName) return 0;
  return a.fieldName < b.fieldName ? -1 : 1;
}
