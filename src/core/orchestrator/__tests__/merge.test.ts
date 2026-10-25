/**
 * Merge unit tests: pure application of a FieldDelta to the in-memory store.
 *
 * Focus: the order in which one delta's parts are applied (reset_field
 * intents, then field values, then every other intent) and the validation of
 * reset_field targets. No LLM, transport, or database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIDENCE_THRESHOLDS,
  type FieldSlot,
  type FieldValues,
  type UserIntent,
} from '../../contracts';
import { AgentRegistry } from '../agent-registry';
import { InMemoryConversationStore } from '../in-memory-store';
import { mergeFieldDelta } from '../merge';
import {
  TEST_CONVERSATION_ID,
  TEST_TENANT_ID,
  TEST_USER_ID,
  buildDelta,
  buildFixtureCard,
  fakeTaskId,
  fixtureEchoHandler,
} from '../../__tests__/_fixtures';

const AGENT = 'merge-agent';
const OLD_VALUE = 'Dulce Hogar';
const NEW_VALUE = 'Dulce Casa';

/** Pending band: at or above STORE_AND_CONFIRM, below AUTO_ACCEPT. */
const HIGH_PENDING = CONFIDENCE_THRESHOLDS.AUTO_ACCEPT - 0.05;
const LOW_PENDING = CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM + 0.05;
const HIGH_FILLED = CONFIDENCE_THRESHOLDS.AUTO_ACCEPT + 0.05;
const BELOW_STORE = CONFIDENCE_THRESHOLDS.STORE_AND_CONFIRM - 0.1;

let registry: AgentRegistry;
let store: InMemoryConversationStore;

beforeEach(async () => {
  registry = new AgentRegistry();
  registry.register(
    buildFixtureCard({
      id: AGENT,
      required: [{ name: 'business_name' }, { name: 'style_keywords' }],
      optional: [{ name: 'color_palette' }],
    }),
    fixtureEchoHandler,
    undefined,
  );
  store = new InMemoryConversationStore(registry.getFieldSchemas());
  await store.getOrCreate(TEST_CONVERSATION_ID, TEST_TENANT_ID, TEST_USER_ID);
});

async function seed(fieldName: string, isRequired: boolean, slot: FieldSlot): Promise<void> {
  await store.updateFieldSlot(TEST_CONVERSATION_ID, AGENT, fieldName, isRequired, slot);
}

function value(fieldName: string, v: unknown, confidence: number): FieldValues {
  return { [AGENT]: { [fieldName]: { value: v, confidence } } };
}

function reset(fieldName: string, agentId: string = AGENT): UserIntent {
  return { kind: 'reset_field', agentId, fieldName };
}

async function agentState() {
  const snapshot = await store.get(TEST_CONVERSATION_ID);
  return snapshot!.agentStates[AGENT];
}

describe('mergeFieldDelta: reset_field + value for the same field', () => {
  it('a correction LESS confident than the old pending value replaces it (pending)', async () => {
    expect(LOW_PENDING).toBeLessThan(HIGH_PENDING);
    await seed('business_name', true, {
      status: 'pending_confirmation',
      value: OLD_VALUE,
      confidence: HIGH_PENDING,
    });

    const result = await mergeFieldDelta(
      buildDelta({
        fields: value('business_name', NEW_VALUE, LOW_PENDING),
        intents: [reset('business_name')],
      }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({
      status: 'pending_confirmation',
      value: NEW_VALUE,
      confidence: LOW_PENDING,
    });
    expect(result.intentOutcomes).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name', outcome: 'reset' },
    ]);
    expect(result.fieldOutcomes).toEqual([
      { agentId: AGENT, fieldName: 'business_name', outcome: 'pending_confirmation', confidence: LOW_PENDING },
    ]);
  });

  it('a correction less confident than an old FILLED value still replaces it', async () => {
    await seed('business_name', true, { status: 'filled', value: OLD_VALUE, confidence: 1.0 });

    await mergeFieldDelta(
      buildDelta({
        fields: value('business_name', NEW_VALUE, LOW_PENDING),
        intents: [reset('business_name')],
      }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({
      status: 'pending_confirmation',
      value: NEW_VALUE,
      confidence: LOW_PENDING,
    });
  });

  it('a correction MORE confident than the old pending value replaces it (filled)', async () => {
    await seed('business_name', true, {
      status: 'pending_confirmation',
      value: OLD_VALUE,
      confidence: LOW_PENDING,
    });

    await mergeFieldDelta(
      buildDelta({
        fields: value('business_name', NEW_VALUE, HIGH_FILLED),
        intents: [reset('business_name')],
      }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({
      status: 'filled',
      value: NEW_VALUE,
      confidence: HIGH_FILLED,
    });
  });

  it('works for optional fields too', async () => {
    await seed('color_palette', false, { status: 'filled', value: 'rojo', confidence: 1.0 });

    await mergeFieldDelta(
      buildDelta({
        fields: value('color_palette', 'azul', LOW_PENDING),
        intents: [reset('color_palette')],
      }),
      store,
      registry,
    );

    expect((await agentState()).optionalFields.color_palette).toEqual({
      status: 'pending_confirmation',
      value: 'azul',
      confidence: LOW_PENDING,
    });
  });

  it('a correction below STORE_AND_CONFIRM is dropped and the reset still empties the field', async () => {
    await seed('business_name', true, {
      status: 'pending_confirmation',
      value: OLD_VALUE,
      confidence: HIGH_PENDING,
    });

    const result = await mergeFieldDelta(
      buildDelta({
        fields: value('business_name', NEW_VALUE, BELOW_STORE),
        intents: [reset('business_name')],
      }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({ status: 'empty' });
    expect(result.fieldOutcomes.map((o) => o.outcome)).toEqual(['rejected_low_confidence']);
  });

  it('a reset of one field does not lift the conflict check on another field', async () => {
    await seed('business_name', true, { status: 'filled', value: OLD_VALUE, confidence: 1.0 });
    await seed('style_keywords', true, { status: 'filled', value: 'rústico', confidence: 1.0 });

    await mergeFieldDelta(
      buildDelta({
        fields: value('business_name', NEW_VALUE, LOW_PENDING),
        intents: [reset('style_keywords')],
      }),
      store,
      registry,
    );

    const state = await agentState();
    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: OLD_VALUE,
      confidence: 1.0,
    });
    expect(state.requiredFields.style_keywords).toEqual({ status: 'empty' });
  });
});

describe('mergeFieldDelta: reset_field alone', () => {
  it('empties a field that had a value', async () => {
    await seed('business_name', true, {
      status: 'pending_confirmation',
      value: OLD_VALUE,
      confidence: HIGH_PENDING,
    });

    const result = await mergeFieldDelta(
      buildDelta({ intents: [reset('business_name')] }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({ status: 'empty' });
    expect(result.mutationsApplied).toBe(1);
    expect(result.fieldOutcomes).toEqual([]);
  });

  it('on a field with no value leaves it empty and touches nothing else', async () => {
    await seed('style_keywords', true, { status: 'filled', value: 'rústico', confidence: 1.0 });
    const before = await agentState();
    expect(before.requiredFields.business_name).toEqual({ status: 'empty' });

    const result = await mergeFieldDelta(
      buildDelta({ intents: [reset('business_name')] }),
      store,
      registry,
    );

    const after = await agentState();
    expect(after.requiredFields).toEqual(before.requiredFields);
    expect(after.optionalFields).toEqual(before.optionalFields);
    expect(result.intentOutcomes).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'business_name', outcome: 'reset' },
    ]);
  });
});

describe('mergeFieldDelta: reset_field validation', () => {
  it('rejects a field absent from the schema, with no state change', async () => {
    await seed('business_name', true, { status: 'filled', value: OLD_VALUE, confidence: 1.0 });
    const before = await agentState();
    const write = vi.spyOn(store, 'updateFieldSlot');

    const result = await mergeFieldDelta(
      buildDelta({ intents: [reset('price')] }),
      store,
      registry,
    );

    expect(write).not.toHaveBeenCalled();
    const after = await agentState();
    expect(after).toEqual(before);
    expect(after.requiredFields).not.toHaveProperty('price');
    expect(after.optionalFields).not.toHaveProperty('price');
    expect(result.mutationsApplied).toBe(0);
    expect(result.intentOutcomes).toEqual([
      { kind: 'reset_field', agentId: AGENT, fieldName: 'price', outcome: 'rejected_unknown_field' },
    ]);
  });

  it('rejects the unknown field the same way an unknown field value is rejected', async () => {
    const result = await mergeFieldDelta(
      buildDelta({
        fields: value('price', '2 soles', 1.0),
        intents: [reset('price')],
      }),
      store,
      registry,
    );

    expect(result.fieldOutcomes.map((o) => o.outcome)).toEqual(['rejected_unknown_field']);
    expect(result.intentOutcomes.map((o) => o.outcome)).toEqual(['rejected_unknown_field']);
    expect(result.mutationsApplied).toBe(0);
  });

  it('rejects an unknown agent, with no state change', async () => {
    const write = vi.spyOn(store, 'updateFieldSlot');

    const result = await mergeFieldDelta(
      buildDelta({ intents: [reset('business_name', 'ghost-agent')] }),
      store,
      registry,
    );

    expect(write).not.toHaveBeenCalled();
    expect(result.intentOutcomes).toEqual([
      {
        kind: 'reset_field',
        agentId: 'ghost-agent',
        fieldName: 'business_name',
        outcome: 'rejected_unknown_agent',
      },
    ]);
  });

  it('a rejected reset does not block a valid reset in the same delta', async () => {
    await seed('business_name', true, { status: 'filled', value: OLD_VALUE, confidence: 1.0 });

    const result = await mergeFieldDelta(
      buildDelta({ intents: [reset('price'), reset('business_name')] }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({ status: 'empty' });
    expect(result.intentOutcomes.map((o) => o.outcome)).toEqual(['rejected_unknown_field', 'reset']);
  });
});

describe('mergeFieldDelta: unchanged behavior', () => {
  it('without a reset, a less confident value still loses the conflict', async () => {
    await seed('business_name', true, {
      status: 'pending_confirmation',
      value: OLD_VALUE,
      confidence: HIGH_PENDING,
    });

    const result = await mergeFieldDelta(
      buildDelta({ fields: value('business_name', NEW_VALUE, LOW_PENDING) }),
      store,
      registry,
    );

    expect((await agentState()).requiredFields.business_name).toEqual({
      status: 'pending_confirmation',
      value: OLD_VALUE,
      confidence: HIGH_PENDING,
    });
    expect(result.fieldOutcomes.map((o) => o.outcome)).toEqual(['conflict_kept_existing']);
  });

  it('select_deliverable, request_iteration and cancel_task write no slots and leave values alone', async () => {
    await seed('business_name', true, { status: 'filled', value: OLD_VALUE, confidence: 1.0 });
    const write = vi.spyOn(store, 'updateFieldSlot');
    const taskId = fakeTaskId();

    const result = await mergeFieldDelta(
      buildDelta({
        fields: value('style_keywords', 'moderno', HIGH_FILLED),
        intents: [
          { kind: 'select_deliverable', deliverableId: crypto.randomUUID() },
          { kind: 'request_iteration', agentId: AGENT, refinement: { parentTaskId: taskId } },
          { kind: 'cancel_task', taskId },
        ],
      }),
      store,
      registry,
    );

    // Only the field value is written.
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.mutationsApplied).toBe(1);
    const state = await agentState();
    expect(state.requiredFields.business_name).toEqual({
      status: 'filled',
      value: OLD_VALUE,
      confidence: 1.0,
    });
    expect(state.requiredFields.style_keywords).toEqual({
      status: 'filled',
      value: 'moderno',
      confidence: HIGH_FILLED,
    });
    expect(result.intentOutcomes).toEqual([
      { kind: 'select_deliverable', outcome: 'noop' },
      { kind: 'request_iteration', agentId: AGENT, outcome: 'deferred_to_dispatch' },
      { kind: 'cancel_task', outcome: 'deferred_to_dispatch' },
    ]);
  });

  it('applies the confidence thresholds and rejects unknown agents and fields as before', async () => {
    const result = await mergeFieldDelta(
      buildDelta({
        fields: {
          [AGENT]: {
            business_name: { value: NEW_VALUE, confidence: HIGH_FILLED },
            style_keywords: { value: 'moderno', confidence: LOW_PENDING },
            color_palette: { value: 'azul', confidence: BELOW_STORE },
            price: { value: '2 soles', confidence: 1.0 },
          },
          'ghost-agent': { business_name: { value: NEW_VALUE, confidence: 1.0 } },
        },
      }),
      store,
      registry,
    );

    expect(result.fieldOutcomes.map((o) => [o.agentId, o.fieldName, o.outcome])).toEqual([
      [AGENT, 'business_name', 'filled'],
      [AGENT, 'style_keywords', 'pending_confirmation'],
      [AGENT, 'color_palette', 'rejected_low_confidence'],
      [AGENT, 'price', 'rejected_unknown_field'],
      ['ghost-agent', 'business_name', 'rejected_unknown_agent'],
    ]);
    expect(result.mutationsApplied).toBe(2);
    expect((await agentState()).optionalFields.color_palette).toEqual({ status: 'empty' });
  });

  it('throws for an unknown conversation', async () => {
    await expect(
      mergeFieldDelta(
        buildDelta({ conversationId: '00000000-0000-0000-0000-0000000000ff' }),
        store,
        registry,
      ),
    ).rejects.toThrow(/unknown conversation/);
  });
});
