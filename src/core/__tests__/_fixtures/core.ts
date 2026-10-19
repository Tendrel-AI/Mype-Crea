/**
 * Stand-in OrchestratorCore for tests that only need the interface satisfied
 * (e.g. ChatInputAdapter tests that exercise the extractor without dispatch).
 */
import type {
  ConversationSnapshot,
  OrchestratorCore,
  PlannerDecision,
} from '../../contracts';
import { buildSnapshot } from './snapshot';

export interface FakeOrchestratorCoreOptions {
  readonly decisions?: ReadonlyArray<PlannerDecision>;
  readonly snapshot?: ConversationSnapshot;
}

/**
 * Build a no-op OrchestratorCore. `applyDelta` returns the supplied snapshot
 * (or an empty one), `getNextDecision` returns the supplied decisions
 * (defaulting to `[announce_all_complete]`).
 */
export function buildFakeCore(opts: FakeOrchestratorCoreOptions = {}): OrchestratorCore {
  const snapshot = opts.snapshot ?? buildSnapshot();
  const decisions =
    opts.decisions ?? ([{ kind: 'announce_all_complete' }] as ReadonlyArray<PlannerDecision>);
  return {
    applyDelta: async () => snapshot,
    getNextDecision: async () => decisions,
    peekNextDecision: async () => decisions,
    acknowledgeDecisions: async () => undefined,
    getSnapshot: async () => snapshot,
  };
}
