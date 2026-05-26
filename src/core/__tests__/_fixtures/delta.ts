/**
 * FieldDelta factory for tests.
 *
 * Defaults to an empty delta with the standard test conversation id. Tests
 * spread overrides for the `fields` or `intents` they want to exercise.
 */
import type { FieldDelta } from '../../contracts';
import { TEST_CONVERSATION_ID } from './snapshot';

export function buildDelta(overrides: Partial<FieldDelta> = {}): FieldDelta {
  return {
    conversationId: TEST_CONVERSATION_ID,
    source: 'test',
    timestamp: new Date().toISOString(),
    fields: {},
    ...overrides,
  };
}
