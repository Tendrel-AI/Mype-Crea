/**
 * Stand-in OrchestratorCore for tests that only need the interface satisfied
 * (e.g. ChatInputAdapter tests that exercise the extractor without dispatch).
 */
import type {
  ConversationSnapshot,
  OrchestratorCore,
  PlannerDecision,
} from '../../contracts';
import type { IApprovalStore } from '../../approvals';
import { buildSnapshot } from './snapshot';

export interface FakeOrchestratorCoreOptions {
  readonly decisions?: ReadonlyArray<PlannerDecision>;
  readonly snapshot?: ConversationSnapshot;
}

/**
 * Build a no-op OrchestratorCore. `applyDelta` returns the supplied snapshot and no rejections
 * (or an empty one), `getNextDecision` returns the supplied decisions
 * (defaulting to `[announce_all_complete]`).
 */
export function buildFakeCore(opts: FakeOrchestratorCoreOptions = {}): OrchestratorCore {
  const snapshot = opts.snapshot ?? buildSnapshot();
  const decisions =
    opts.decisions ?? ([{ kind: 'announce_all_complete' }] as ReadonlyArray<PlannerDecision>);
  return {
    applyDelta: async () => ({ snapshot, rejected: [] }),
    getNextDecision: async () => decisions,
    peekNextDecision: async () => decisions,
    acknowledgeDecisions: async () => undefined,
    getSnapshot: async () => snapshot,
  };
}

/**
 * Approval store with one fixed approval per kind and no stale marks. Tests
 * that exercise the logo flow use it to satisfy the KAN-35 dependency map
 * (verbal identity → logo: the logo needs an approved business name).
 */
export function buildApprovedStore(approved: Readonly<Record<string, string>>): IApprovalStore {
  return {
    approve: async () => ({ ok: false, reason: 'not_found' }),
    getApproved: async () =>
      Object.entries(approved).map(([deliverableKind, deliverableId]) => ({
        deliverableKind,
        deliverableId,
        approvedAt: '2026-11-02T00:00:00.000Z',
      })),
    getStaleKinds: async () => [],
  };
}

/** A fixed approved business-name deliverable id (only referenced, never read as a row). */
export const APPROVED_NAME_ID = '0e0e0e0e-0000-4000-8000-00000000a11e';
