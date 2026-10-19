/**
 * Fixed identities for eval runs. Reuses the stable test UUIDs so eval
 * traces are easy to tell apart from real tenants.
 */
import type { LlmLoggingContext } from '../../src/services/llm-logger';
import {
  TEST_CONVERSATION_ID,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from '../../src/core/__tests__/_fixtures/snapshot';

export const EVAL_CONVERSATION_ID = TEST_CONVERSATION_ID;
export const EVAL_TENANT_ID = TEST_TENANT_ID;

/** `promptVersion` is overwritten by each adapter with its own constant. */
export const evalLlmContext: LlmLoggingContext = {
  tenant: { id: TEST_TENANT_ID },
  user: { id: TEST_USER_ID },
  conversationId: TEST_CONVERSATION_ID,
  promptVersion: 'eval',
};
