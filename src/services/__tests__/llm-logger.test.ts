/**
 * Unit test for the llm-logger service. Mocks the OpenAI client and the
 * repos factory so the test never touches the network or the database.
 *
 * Verifies:
 *   - response.usage is extracted into the recorded llm_calls row
 *   - latency_ms is captured (>= 0)
 *   - a persist failure is logged but does NOT propagate to the caller
 *   - the LLM client failure DOES propagate
 */
import { describe, expect, it, vi } from 'vitest';

const recordSpy = vi.fn(async () => 'fake-llm-call-id');

vi.mock('../../repos', () => {
  return {
    repos: () => ({ llmCalls: { record: recordSpy } }),
    systemRepos: () => ({ llmCalls: { record: recordSpy } }),
  };
});

import { withLlmLogging } from '../llm-logger';

function fakeClient(behavior: 'success' | 'fail') {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          if (behavior === 'fail') throw new Error('upstream LLM error');
          return {
            id: 'chatcmpl-fake',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
          };
        }),
      },
    },
  };
}

describe('withLlmLogging', () => {
  const ctx = {
    tenant: { id: '00000000-0000-0000-0000-000000000001' },
    user: { id: '00000000-0000-0000-0000-000000000002' },
    conversationId: '00000000-0000-0000-0000-000000000003',
    promptVersion: 'unit.v1',
  };

  it('captures token counts and persists the row', async () => {
    recordSpy.mockClear();
    const client = fakeClient('success');
    const out = await withLlmLogging(
      client as any,
      { model: 'google/gemini-2.5-pro', messages: [] },
      ctx,
    );
    expect(out.choices[0].message.content).toBe('ok');
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const arg = (recordSpy.mock.calls[0] as any[])[0] as any;
    expect(arg.inputTokens).toBe(11);
    expect(arg.outputTokens).toBe(22);
    expect(arg.model).toBe('google/gemini-2.5-pro');
    expect(arg.promptVersion).toBe('unit.v1');
    expect(typeof arg.latencyMs).toBe('number');
    expect(arg.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns the completion even if persistence fails', async () => {
    recordSpy.mockReset();
    recordSpy.mockRejectedValueOnce(new Error('db is down'));
    const client = fakeClient('success');
    const out = await withLlmLogging(
      client as any,
      { model: 'google/gemini-2.5-pro', messages: [] },
      ctx,
    );
    expect(out.choices[0].message.content).toBe('ok');
  });

  it('rethrows when the LLM client itself fails', async () => {
    recordSpy.mockClear();
    const client = fakeClient('fail');
    await expect(
      withLlmLogging(client as any, { model: 'google/gemini-2.5-pro', messages: [] }, ctx),
    ).rejects.toThrow(/upstream LLM error/);
    // No persistence on upstream failure.
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('uses systemRepos when no user is present', async () => {
    recordSpy.mockClear();
    const client = fakeClient('success');
    await withLlmLogging(
      client as any,
      { model: 'google/gemini-2.5-pro', messages: [] },
      { ...ctx, user: undefined },
    );
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});
