import { afterEach, describe, expect, it, vi } from 'vitest';

const original = {
  provider: process.env.LLM_PROVIDER,
  openrouterKey: process.env.OPENROUTER_API_KEY,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  logLevel: process.env.LOG_LEVEL,
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
});
