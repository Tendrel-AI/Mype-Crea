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
  return decisions.find((d) => d.kind === 'confirm_fields') ?? decisions.find((d) => d.kind === 'request_fields');
}
