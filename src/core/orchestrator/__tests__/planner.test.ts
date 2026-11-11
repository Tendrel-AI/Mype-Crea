/**
 * Planner unit tests — pure-code rules over a snapshot.
 *
 * These exercise the deterministic core of the orchestrator without touching
 * the LLM provider, transport, or store. Each test builds a synthetic
 * snapshot directly (no merge stage) and asserts the plan returned by
 * planNextDecision.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationSnapshot } from '../../contracts';
import { planNextDecision } from '../planner';
import { deriveDeliverableStates, EMPTY_WORKFLOW_FACTS } from '../deliverable-state';
import {
  AgentRegistry,
  type AgentCard,
} from '../agent-registry';
import { buildFixtureCard, fixtureEchoHandler } from '../../__tests__/_fixtures/registry';

const conversationId = '00000000-0000-0000-0000-000000000003';
const tenantId = '00000000-0000-0000-0000-000000000001';

function makeRegistry(cards: ReadonlyArray<AgentCard>): AgentRegistry {
  const registry = new AgentRegistry();
  for (const card of cards) registry.register(card, fixtureEchoHandler, undefined);
  return registry;
}

function snapshotWith(
  agentStates: ConversationSnapshot['agentStates'],
): ConversationSnapshot {
  return {
    conversationId,
    tenantId,
    agentStates,
    updatedAt: new Date().toISOString(),
  };
}

describe('planNextDecision', () => {
  it('returns a single request_fields with up to MAX_FIELD_BATCH_SIZE missing fields from the focus agent', () => {
    const registry = makeRegistry([
      buildFixtureCard({
        id: 'agent-a',
        required: [
          { name: 'a_field_1' },
          { name: 'a_field_2' },
          { name: 'a_field_3' },
        ],
      }),
    ]);
    const snapshot = snapshotWith({
      'agent-a': {
        requiredFields: {},
        optionalFields: {},
        iterationCount: 0,
      },
    });

    const plan = planNextDecision(snapshot, registry);
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('request_fields');
    if (plan[0].kind === 'request_fields') {
      expect(plan[0].agentId).toBe('agent-a');
      // Lex-first up to MAX_FIELD_BATCH_SIZE (=2).
      expect(plan[0].fields.map((f) => f.fieldName)).toEqual([
        'a_field_1',
        'a_field_2',
      ]);
    }
  });

  it('focuses on the lex-first eligible agent and skips agents already in flight', () => {
    const registry = makeRegistry([
      buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }] }),
      buildFixtureCard({ id: 'agent-b', required: [{ name: 'b_field' }] }),
    ]);
    const snapshot = snapshotWith({
      // agent-a is in flight (skip)
      'agent-a': {
        requiredFields: { a_field: { status: 'empty' } },
        optionalFields: {},
        lastDispatchedTaskId: '11111111-1111-1111-1111-111111111111',
        iterationCount: 0,
      },
      'agent-b': {
        requiredFields: { b_field: { status: 'empty' } },
        optionalFields: {},
        iterationCount: 0,
      },
    });

    const plan = planNextDecision(snapshot, registry);
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe('request_fields');
    if (plan[0].kind === 'request_fields') {
      expect(plan[0].agentId).toBe('agent-b');
    }
  });

  it('skips agents that have already been dispatched (iterationCount > 0)', () => {
    const registry = makeRegistry([
      buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }] }),
      buildFixtureCard({ id: 'agent-b', required: [{ name: 'b_field' }] }),
    ]);
    const snapshot = snapshotWith({
      'agent-a': {
        requiredFields: { a_field: { status: 'filled', value: 'x', confidence: 1 } },
        optionalFields: {},
        iterationCount: 1, // already dispatched
      },
      'agent-b': {
        requiredFields: { b_field: { status: 'empty' } },
        optionalFields: {},
        iterationCount: 0,
      },
    });

    const plan = planNextDecision(snapshot, registry);
    expect(plan).toHaveLength(1);
    if (plan[0].kind === 'request_fields') {
      expect(plan[0].agentId).toBe('agent-b');
    } else {
      throw new Error(`expected request_fields, got ${plan[0].kind}`);
    }
  });

  it('emits a solo confirm_field when any required slot is pending_confirmation', () => {
    const registry = makeRegistry([
      buildFixtureCard({
        id: 'agent-a',
        required: [{ name: 'a_field_1' }, { name: 'a_field_2' }],
      }),
    ]);
    const snapshot = snapshotWith({
      'agent-a': {
        requiredFields: {
          a_field_1: { status: 'pending_confirmation', value: 'maybe', confidence: 0.7 },
          a_field_2: { status: 'empty' },
        },
        optionalFields: {},
        iterationCount: 0,
      },
    });

    const plan = planNextDecision(snapshot, registry);
    expect(plan).toEqual([
      {
        kind: 'confirm_field',
        agentId: 'agent-a',
        fieldName: 'a_field_1',
        pendingValue: 'maybe',
        reason: 'low_confidence',
      },
    ]);
  });

  it('also confirms a pending OPTIONAL slot before asking for anything else (KAN-26)', () => {
    const registry = makeRegistry([
      buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field_1' }], optional: [{ name: 'a_opt' }] }),
    ]);
    const snapshot = snapshotWith({
      'agent-a': {
        requiredFields: { a_field_1: { status: 'empty' } },
        optionalFields: { a_opt: { status: 'pending_confirmation', value: 'quizá', confidence: 0.7 } },
        iterationCount: 0,
      },
    });

    expect(planNextDecision(snapshot, registry)).toEqual([
      { kind: 'confirm_field', agentId: 'agent-a', fieldName: 'a_opt', pendingValue: 'quizá', reason: 'low_confidence' },
    ]);
  });

  it('returns announce_all_complete when no agent is eligible to ask or in-flight', () => {
    const registry = makeRegistry([
      buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }] }),
    ]);
    const snapshot = snapshotWith({
      'agent-a': {
        requiredFields: {
          a_field: { status: 'filled', value: 'x', confidence: 1 },
        },
        optionalFields: {},
        iterationCount: 1, // already dispatched
      },
    });

    const plan = planNextDecision(snapshot, registry);
    expect(plan).toEqual([{ kind: 'announce_all_complete' }]);
  });

  it('drops the in-flight agent from the focus pool but keeps other agents reachable', () => {
    const registry = makeRegistry([
      buildFixtureCard({ id: 'agent-a', required: [{ name: 'shared' }, { name: 'only_a' }] }),
      buildFixtureCard({ id: 'agent-b', required: [{ name: 'shared' }, { name: 'only_b' }] }),
    ]);
    const snapshot = snapshotWith({
      'agent-a': {
        requiredFields: {
          shared: { status: 'filled', value: 'x', confidence: 1 },
          only_a: { status: 'filled', value: 'y', confidence: 1 },
        },
        optionalFields: {},
        lastDispatchedTaskId: '11111111-1111-1111-1111-111111111111',
        iterationCount: 0,
      },
      'agent-b': {
        requiredFields: {
          shared: { status: 'filled', value: 'x', confidence: 1 },
          only_b: { status: 'empty' },
        },
        optionalFields: {},
        iterationCount: 0,
      },
    });

    const plan = planNextDecision(snapshot, registry);
    expect(plan).toHaveLength(1);
    if (plan[0].kind === 'request_fields') {
      expect(plan[0].agentId).toBe('agent-b');
      expect(plan[0].fields.map((f) => f.fieldName)).toEqual(['only_b']);
    } else {
      throw new Error(`expected request_fields, got ${plan[0].kind}`);
    }
  });

  describe('Rule 3 — offer_generation (KAN-64: never dispatches)', () => {
    const filledA = {
      'agent-a': {
        requiredFields: { a_field: { status: 'filled', value: 'x', confidence: 1 } },
        optionalFields: {},
        iterationCount: 0,
      },
    } as const;

    it('offers «Generar» for a ready, never-generated agent (snapshot fallback)', () => {
      const registry = makeRegistry([
        buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }], deliverableKind: 'logo' }),
      ]);
      expect(planNextDecision(snapshotWith(filledA), registry)).toEqual([
        { kind: 'offer_generation', agentId: 'agent-a', deliverableKind: 'logo' },
      ]);
    });

    it('uses the derived deliverable states when provided', () => {
      const registry = makeRegistry([
        buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }] }),
      ]);
      const snapshot = snapshotWith(filledA);
      expect(
        planNextDecision(snapshot, registry, {
          deliverableStates: [{ agentId: 'agent-a', deliverableKind: 'agent-a', state: 'in_review' }],
        }),
      ).toEqual([{ kind: 'announce_all_complete' }]);
      expect(
        planNextDecision(snapshot, registry, {
          deliverableStates: [
            { agentId: 'agent-z', deliverableKind: 'z', state: 'enabled' },
            { agentId: 'agent-a', deliverableKind: 'a', state: 'enabled' },
          ],
        }),
      ).toEqual([{ kind: 'offer_generation', agentId: 'agent-a', deliverableKind: 'a' }]);
    });

    it('does not offer an agent that is blocked on an upstream approval', () => {
      const registry = makeRegistry([
        buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }], dependsOn: ['logo'] }),
      ]);
      expect(
        planNextDecision(snapshotWith(filledA), registry, {
          deliverableStates: [{ agentId: 'agent-a', deliverableKind: 'agent-a', state: 'blocked' }],
        }),
      ).toEqual([{ kind: 'announce_all_complete' }]);
    });

    it('confirmation and field collection still take precedence over the offer', () => {
      const registry = makeRegistry([
        buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }] }),
        buildFixtureCard({ id: 'agent-b', required: [{ name: 'b_field' }] }),
      ]);
      const plan = planNextDecision(
        snapshotWith({ ...filledA, 'agent-b': { requiredFields: {}, optionalFields: {}, iterationCount: 0 } }),
        registry,
        { deliverableStates: [{ agentId: 'agent-a', deliverableKind: 'agent-a', state: 'enabled' }] },
      );
      expect(plan[0].kind).toBe('request_fields');
    });

    it('same snapshot and states produce the same plan', () => {
      const registry = makeRegistry([
        buildFixtureCard({ id: 'agent-a', required: [{ name: 'a_field' }] }),
      ]);
      const context = { deliverableStates: [{ agentId: 'agent-a', deliverableKind: 'agent-a', state: 'enabled' as const }] };
      expect(planNextDecision(snapshotWith(filledA), registry, context)).toEqual(
        planNextDecision(snapshotWith(filledA), registry, context),
      );
    });
  });

  describe('per-card ask batch size', () => {
    const names = Array.from({ length: 6 }, (_, i) => ({ name: `f_${i}` }));

    it('asks every missing required field in ONE decision when the card sets askBatchSize', () => {
      const registry = makeRegistry([buildFixtureCard({ id: 'agent-a', required: names, askBatchSize: 6 })]);
      const [decision] = planNextDecision(snapshotWith({ 'agent-a': { requiredFields: { f_3: { status: 'filled', value: 'x', confidence: 1 } }, optionalFields: {}, iterationCount: 0 } }), registry);
      expect(decision.kind === 'request_fields' && decision.fields.map((f) => f.fieldName)).toEqual(['f_0', 'f_1', 'f_2', 'f_4', 'f_5']);
    });

    it('keeps MAX_FIELD_BATCH_SIZE (2) for a card without askBatchSize', () => {
      const registry = makeRegistry([buildFixtureCard({ id: 'agent-b', required: names })]);
      const [decision] = planNextDecision(snapshotWith({ 'agent-b': { requiredFields: {}, optionalFields: {}, iterationCount: 0 } }), registry);
      expect(decision.kind === 'request_fields' && decision.fields).toHaveLength(2);
    });
  });

  describe('a brand-level brief is asked only when the deliverable still needs it (derived states)', () => {
    const logo = buildFixtureCard({ id: 'logo', required: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], askBatchSize: 3, level: 'brand', ownSource: 'brand_logo' });
    const registry = makeRegistry([logo]);
    const empty = { logo: { requiredFields: {}, optionalFields: {}, iterationCount: 0 } };
    const plan = (snapshot: ConversationSnapshot, facts = EMPTY_WORKFLOW_FACTS) =>
      planNextDecision(snapshot, registry, { deliverableStates: deriveDeliverableStates(snapshot, registry.getDeliverableSpecs(), facts) });

    it('asks all missing fields in a brand conversation with no logo yet', () => {
      const [decision] = plan(snapshotWith(empty));
      expect(decision.kind === 'request_fields' && decision.fields).toHaveLength(3);
    });

    it('does not ask when the brand already has an approved (or own, user-origin) logo', () => {
      const facts = { ...EMPTY_WORKFLOW_FACTS, approvals: [{ deliverableKind: 'logo', deliverableId: 'd1' }] };
      expect(plan(snapshotWith(empty), facts)).toEqual([{ kind: 'announce_all_complete' }]);
    });

    it('does not ask in a product conversation (brand level is read-only)', () => {
      const snapshot = { ...snapshotWith(empty), links: { hasBrand: true, hasProduct: true } } as ConversationSnapshot;
      expect(plan(snapshot)).toEqual([{ kind: 'announce_all_complete' }]);
    });

    it('does not ask once the logo was generated or iterated (iterationCount > 0)', () => {
      expect(plan(snapshotWith({ logo: { ...empty.logo, iterationCount: 1 } }))).toEqual([{ kind: 'announce_all_complete' }]);
    });
  });
});
