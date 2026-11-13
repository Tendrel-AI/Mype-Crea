import type { PlannerDecision } from '../../src/core/contracts';

/** The persisted turn fields the lookup reads. */
export interface PriorTurn {
  readonly id: string;
  readonly stage: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The decision the extractor interprets the next reply against (D35): the confirmation of the most
 * recent answered turn, else the questions it asked. `turnsNewestFirst` is `aiTurns.listTurns` order
 * (`created_at DESC`); an older turn must never stand in for the latest one.
 */
export function priorDecisionFrom(
  turnsNewestFirst: ReadonlyArray<PriorTurn>,
  currentTurnId: string,
): PlannerDecision | undefined {
  const previous = turnsNewestFirst.find((turn) => turn.id !== currentTurnId && turn.stage === 'responded');
  const decisions = Array.isArray(previous?.payload['decisions']) ? (previous!.payload['decisions'] as PlannerDecision[]) : [];
  return questionOf(decisions);
}

/**
 * D47: the user's first reply has no responded turn (the welcome message is not a turn), so it is read
 * against the planner's current decision, which is exactly what the welcome rendered. `peek` is lazy:
 * it only runs when this really is the first reply.
 */
export async function priorDecisionOrWelcome(
  turnsNewestFirst: ReadonlyArray<PriorTurn>,
  currentTurnId: string,
  peek: () => Promise<ReadonlyArray<PlannerDecision>>,
): Promise<PlannerDecision | undefined> {
  const prior = priorDecisionFrom(turnsNewestFirst, currentTurnId);
  if (prior || turnsNewestFirst.some((turn) => turn.id !== currentTurnId && turn.stage === 'responded')) return prior;
  return questionOf(await peek());
}

function questionOf(decisions: ReadonlyArray<PlannerDecision>): PlannerDecision | undefined {
  return decisions.find((d) => d.kind === 'confirm_fields') ?? decisions.find((d) => d.kind === 'request_fields');
}
