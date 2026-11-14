import { describe, expect, it, vi } from 'vitest';
import type { ILLMProvider, ResolvedModel } from '../../llm/types';
import { ProviderRegistry, ProfileUnavailableError } from '../provider-registry';
import type { ModelProfile } from '../manifest';

const profile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'extractor',
  purpose: 'extractor',
  provider: 'openrouter',
  model: 'google/gemini-2.5-flash',
  modelRevision: null,
  credentialRef: 'platform.openrouter',
  capabilities: ['forced-tool-call', 'json-schema'],
  settings: { temperature: 0, maxTokens: 512 },
  ...overrides,
});

function fakeProvider(create: ResolvedModel['client']['chat']['completions']['create']): ILLMProvider {
  const client: ResolvedModel['client'] = {
    chat: { completions: { create } },
  };
  return { resolve: (purpose) => ({ client, modelId: 'google/gemini-2.5-flash', purpose, provider: 'openrouter' }) };
}

describe('ProviderRegistry', () => {
  it('rejects oversized context before calling the provider', async () => {
    const completion = vi.fn(async () => ({ id: 'response', choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    const registry = new ProviderRegistry(() => 'test-key', () => fakeProvider(completion));
    const resolved = registry.resolve(profile(), 'extractor', { tenantId: 'tenant', releaseId: 'release', profileId: 'extractor' });

    expect(() => resolved.client.chat.completions.create({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }],
      temperature: 0,
      max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'submit' } }],
      tool_choice: 'required',
    })).toThrow(ProfileUnavailableError);
    expect(completion).not.toHaveBeenCalled();
  });

  it('fails closed when the frozen output ceiling exceeds the trusted model cap', async () => {
    const completion = vi.fn(async () => ({ id: 'response', choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    const registry = new ProviderRegistry(() => 'test-key', () => fakeProvider(completion));
    expect(() => registry.resolve(profile({ settings: { temperature: 0, maxTokens: 65_537 } }), 'extractor', {
      tenantId: 'tenant', releaseId: 'release', profileId: 'extractor',
    })).toThrow(ProfileUnavailableError);
    expect(completion).not.toHaveBeenCalled();
  });
});
