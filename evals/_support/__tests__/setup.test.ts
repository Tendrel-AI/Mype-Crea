import { afterEach, describe, expect, it, vi } from 'vitest';

const original = {
  provider: process.env.LLM_PROVIDER,
  openrouterKey: process.env.OPENROUTER_API_KEY,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  logLevel: process.env.LOG_LEVEL,
  profile: process.env.EVAL_MODEL_PROFILE,
  openrouterResponder: process.env.OPENROUTER_RESPONDER_MODEL,
  judge: process.env.EVAL_JUDGE_MODEL,
};

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restoreEnv('LLM_PROVIDER', original.provider);
  restoreEnv('OPENROUTER_API_KEY', original.openrouterKey);
  restoreEnv('ANTHROPIC_API_KEY', original.anthropicKey);
  restoreEnv('LOG_LEVEL', original.logLevel);
  restoreEnv('EVAL_MODEL_PROFILE', original.profile);
  restoreEnv('OPENROUTER_RESPONDER_MODEL', original.openrouterResponder);
  restoreEnv('EVAL_JUDGE_MODEL', original.judge);
  vi.resetModules();
});

describe('eval setup provider credentials', () => {
  it('starts in Anthropic mode when only the selected key is present', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    delete process.env.OPENROUTER_API_KEY;

    await expect(import('../setup')).resolves.toBeDefined();
  });

  it('starts in OpenRouter mode when only the selected key is present', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    delete process.env.ANTHROPIC_API_KEY;

    await expect(import('../setup')).resolves.toBeDefined();
  });

  it('fails clearly when the selected provider key is missing', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = 'must-not-be-used';

    await expect(import('../setup')).rejects.toThrow(/set ANTHROPIC_API_KEY/);
  });

  it('applies the opt-in cheap profile over models copied from .env.example', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    process.env.OPENROUTER_RESPONDER_MODEL = 'google/gemini-2.5-pro';
    process.env.EVAL_MODEL_PROFILE = 'cheap';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await import('../setup');

    expect(process.env.OPENROUTER_RESPONDER_MODEL).toBe('google/gemini-2.5-flash-lite');
    expect(process.env.EVAL_JUDGE_MODEL).toBe('google/gemini-2.5-flash-lite');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('EVAL_MODEL_PROFILE=cheap'));
    info.mockRestore();
  });

  it('leaves models untouched when no profile is set', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    process.env.OPENROUTER_RESPONDER_MODEL = 'google/gemini-2.5-pro';
    delete process.env.EVAL_MODEL_PROFILE;

    await import('../setup');

    expect(process.env.OPENROUTER_RESPONDER_MODEL).toBe('google/gemini-2.5-pro');
  });
});

describe('langsmith createFeedback start_time workaround', () => {
  it('converts a numeric startTime to an ISO string in both call forms', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    const { Client } = await import('langsmith');
    const stub = vi.fn().mockResolvedValue({});
    Client.prototype.createFeedback = stub as never;
    await import('../setup');
    const client = new Client({ apiKey: 'x', autoBatchTracing: false });
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    await client.createFeedback({ runId: 'r', key: 'k', startTime: ms } as never);
    await client.createFeedback('r', 'k', { startTime: ms, score: 1 } as never);
    expect(stub.mock.calls[0][0]).toMatchObject({ startTime: '2026-01-02T03:04:05.000Z' });
    expect(stub.mock.calls[1][2]).toMatchObject({ startTime: '2026-01-02T03:04:05.000Z', score: 1 });
  });
});
