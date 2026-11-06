/**
 * Unit test for the llm-logger service. Mocks the OpenAI client and the
 * repos factory so the test never touches the network or the database.
 *
 * Verifies:
 *   - response.usage is extracted into the recorded llm_calls row
 *   - the effective provider and the purpose of each call are recorded
 *     (KAN-69 A6), and LLM_PROVIDER never overrides the call's provider
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
            model: 'served-model-revision',
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
    provider: 'openrouter' as const,
    purpose: 'responder' as const,
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
    expect(arg.model).toBe('served-model-revision');
    expect(arg.promptVersion).toBe('unit.v1');
    expect(arg.provider).toBe('openrouter');
    expect(arg.purpose).toBe('responder');
    expect(typeof arg.latencyMs).toBe('number');
    expect(arg.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    { purpose: 'extractor' as const, provider: 'openrouter' as const, model: 'google/gemini-2.5-flash' },
    { purpose: 'extractor' as const, provider: 'anthropic' as const, model: 'claude-haiku-5-5' },
    { purpose: 'responder' as const, provider: 'openrouter' as const, model: 'google/gemini-2.5-pro' },
    { purpose: 'responder' as const, provider: 'anthropic' as const, model: 'claude-sonnet-5-5' },
  ])('records provider, model, purpose and tokens for a $purpose call on $provider', async ({ purpose, provider, model }) => {
    recordSpy.mockClear();
    const client = fakeClient('success');
    await withLlmLogging(client as any, { model, messages: [] }, { ...ctx, provider, purpose });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect((recordSpy.mock.calls[0] as any[])[0]).toMatchObject({
      provider,
      purpose,
      model: 'served-model-revision',
      inputTokens: 11,
      outputTokens: 22,
    });
  });

  it('records the provider passed by the call, never LLM_PROVIDER', async () => {
    recordSpy.mockClear();
    const prior = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'anthropic';
    try {
      await withLlmLogging(
        fakeClient('success') as any,
        { model: 'google/gemini-2.5-flash', messages: [] },
        { ...ctx, provider: 'openrouter', purpose: 'extractor' },
      );
    } finally {
      if (prior === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prior;
    }
    expect((recordSpy.mock.calls[0] as any[])[0]).toMatchObject({ provider: 'openrouter', purpose: 'extractor' });
  });

  it('falls back to the requested model and zero tokens when the response omits them', async () => {
    recordSpy.mockClear();
    const client = {
      chat: {
        completions: {
          create: vi.fn(async () => ({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })),
        },
      },
    };
    await withLlmLogging(client as any, { model: 'claude-haiku-5-5', messages: [] }, { ...ctx, provider: 'anthropic', purpose: 'extractor' });
    expect((recordSpy.mock.calls[0] as any[])[0]).toMatchObject({
      provider: 'anthropic',
      purpose: 'extractor',
      model: 'claude-haiku-5-5',
      inputTokens: 0,
      outputTokens: 0,
    });
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
