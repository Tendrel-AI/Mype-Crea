import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('../../logger', () => ({ loggerFor: () => ({ warn: mocks.warn, error: mocks.error, info: vi.fn(), debug: vi.fn() }) }));

// Frozen set under test: extractor v2/v9/v10 (v9 has a parser id this code cannot run), v3 tampered in the file,
// responder v1, and the real files for the rest.
vi.mock('../../../../prompts', async () => {
  const { hashPromptContent } = await import('../../../lib/prompt-ledger');
  const real = (await import('../../../../prompts/extractor/extractor.v5.json')).default as { text: string; schema: Record<string, unknown> };
  const make = (key: string, version: string, text: string, schema?: unknown) => ({
    key, version, text, ...(schema === undefined ? {} : { schema }), contentHash: hashPromptContent({ text, schema }), frozenAt: 'x',
  });
  const extractor = (version: string, schema = real.schema, text = real.text) => make('extractor', version, text, schema);
  const files = [
    extractor('extractor.v2', real.schema, `${real.text}\nv2`),
    extractor('extractor.v9', { ...real.schema, parserVersion: 'extractor.parser.v999' }),
    extractor('extractor.v10', real.schema, `${real.text}\nv10`),
    extractor('extractor.v3', real.schema, `${real.text}\nv3`),
    make('responder', 'responder.chat-step1.v6', 'r', { rendererVersion: 'x' }),
    make('name-agent', 'name-agent.v1', 'n'),
    make('tagline-agent', 'tagline-agent.v1', 't'),
    make('logo-agent', 'logo-agent.v1', 'l'),
  ];
  const lock: Record<string, Record<string, string>> = {};
  for (const f of files) (lock[f.key] ??= {})[f.version] = f.contentHash;
  files.find((f) => f.version === 'extractor.v3')!.text += ' tampered'; // file edited after the lock was written
  return { frozenFiles: files, lock };
});

import { activePromptVersion, activePromptVersions, checkActivePrompts, getFrozenPrompt, resolvePinnedPrompt } from '..';
import { resolveAdapterBehavior } from '../adapter-behavior';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('prompt loader', () => {
  it('uses the highest numeric vN of a key (v10 beats v9), and the env var wins over it', () => {
    expect(activePromptVersion('extractor')).toBe('extractor.v10');
    vi.stubEnv('PROMPT_EXTRACTOR', 'extractor.v2');
    expect(activePromptVersion('extractor')).toBe('extractor.v2');
    vi.stubEnv('PROMPT_NAME_AGENT', 'name-agent.v7');
    expect(activePromptVersions()).toMatchObject({ extractor: 'extractor.v2', 'name-agent': 'name-agent.v7' });
  });

  it('returns undefined for an unknown version and for a file whose content no longer matches the lock', () => {
    expect(getFrozenPrompt('extractor', 'extractor.v404')).toBeUndefined();
    expect(getFrozenPrompt('extractor', 'extractor.v3')).toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith({ key: 'extractor', version: 'extractor.v3' }, 'prompt.hash_mismatch');
    expect(getFrozenPrompt('extractor', 'extractor.v2')?.version).toBe('extractor.v2');
  });

  it('reports a missing or tampered active version for readiness, and nothing when all are fine', () => {
    expect(checkActivePrompts()).toEqual([]);
    vi.stubEnv('PROMPT_EXTRACTOR', 'extractor.v3');
    vi.stubEnv('PROMPT_LOGO_AGENT', 'logo-agent.v9');
    expect(checkActivePrompts()).toEqual([expect.stringContaining('extractor@extractor.v3'), expect.stringContaining('logo-agent@logo-agent.v9')]);
  });

  it('resolves the pinned version, and falls back to the active one with a log when it cannot be read', () => {
    expect(resolvePinnedPrompt('extractor', { extractor: 'extractor.v2' })?.version).toBe('extractor.v2');
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(resolvePinnedPrompt('extractor', { extractor: 'extractor.v404' })?.version).toBe('extractor.v10');
    expect(mocks.warn).toHaveBeenCalledWith({ key: 'extractor', pinned: 'extractor.v404', used: 'extractor.v10' }, 'prompt.pin.fallback');
  });
});

describe('resolveAdapterBehavior', () => {
  const fields = [{ name: 'business_name', required: true, promptHint: 'h', agents: ['logo-agent'] }];

  it('without a pin (evals, legacy callers) uses the active version and the registry fields', () => {
    const behavior = resolveAdapterBehavior('extractor', undefined, fields);
    expect(behavior.extractor.promptVersion).toBe('extractor.v10');
    expect(behavior.extractor.fields).toEqual(fields);
    vi.stubEnv('PROMPT_EXTRACTOR', 'extractor.v2');
    expect(resolveAdapterBehavior('extractor', undefined, fields).extractor.promptTemplate).toContain('\nv2');
  });

  it('uses the pinned version over the active one', () => {
    expect(resolveAdapterBehavior('extractor', { extractor: 'extractor.v2' }, fields).extractor.promptVersion).toBe('extractor.v2');
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', 'extractor.v404'],
    ['unsupported (structural gate)', 'extractor.v9'],
  ])('falls back to the active version and logs prompt.pin.fallback when the pin is %s', (_label, pinned) => {
    const behavior = resolveAdapterBehavior('extractor', { extractor: pinned }, fields);
    expect(behavior.extractor.promptVersion).toBe('extractor.v10');
    expect(mocks.warn).toHaveBeenCalledWith({ key: 'extractor', pinned, used: 'extractor.v10' }, 'prompt.pin.fallback');
  });

  it('keeps profile settings of an execution but takes the field list from the registry', () => {
    const execution = {
      model: {} as never,
      behavior: { extractor: { temperature: 0.3, maxTokens: 99, fields: [{ name: 'stale' }] }, responder: {} } as never,
    };
    const { extractor } = resolveAdapterBehavior('extractor', undefined, fields, execution);
    expect(extractor).toMatchObject({ temperature: 0.3, maxTokens: 99, fields, promptVersion: 'extractor.v10' });
  });
});
