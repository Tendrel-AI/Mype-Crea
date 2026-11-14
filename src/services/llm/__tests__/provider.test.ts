import { afterEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  wrapOpenAI: vi.fn((client: unknown) => client),
  traceable: vi.fn((fn: (...args: never[]) => unknown) => fn),
}));
vi.mock('langsmith/wrappers', () => ({
  wrapOpenAI: (client: unknown) => spies.wrapOpenAI(client),
}));
vi.mock('langsmith/traceable', () => ({
  traceable: (fn: (...args: never[]) => unknown) => spies.traceable(fn),
}));
import { getProvider, resetProvider } from '../index';
import { AnthropicProvider } from '../anthropic-provider';
import { OpenRouterProvider } from '../openrouter-provider';
import type { ChatRequest } from '../types';

const env = {
  provider: process.env.LLM_PROVIDER,
  openrouter: process.env.OPENROUTER_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  openrouterExtractorModel: process.env.OPENROUTER_EXTRACTOR_MODEL,
  openrouterResponderModel: process.env.OPENROUTER_RESPONDER_MODEL,
  anthropicExtractorModel: process.env.ANTHROPIC_EXTRACTOR_MODEL,
  anthropicResponderModel: process.env.ANTHROPIC_RESPONDER_MODEL,
  tracing: process.env.LANGSMITH_TRACING,
};
afterEach(() => {
  resetProvider();
  restoreEnv('LLM_PROVIDER', env.provider);
  restoreEnv('OPENROUTER_API_KEY', env.openrouter);
  restoreEnv('ANTHROPIC_API_KEY', env.anthropic);
  restoreEnv('OPENROUTER_EXTRACTOR_MODEL', env.openrouterExtractorModel);
  restoreEnv('OPENROUTER_RESPONDER_MODEL', env.openrouterResponderModel);
  restoreEnv('ANTHROPIC_EXTRACTOR_MODEL', env.anthropicExtractorModel);
  restoreEnv('ANTHROPIC_RESPONDER_MODEL', env.anthropicResponderModel);
  restoreEnv('LANGSMITH_TRACING', env.tracing);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  spies.wrapOpenAI.mockClear();
  spies.traceable.mockClear();
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function anthropicTextResponse(): Response {
  return new Response(JSON.stringify({
    id: 'msg_trace',
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200 });
}

describe('LLM provider configuration', () => {
  it('defaults to Anthropic (Claude) when LLM_PROVIDER is unset', () => {
    delete process.env.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    delete process.env.ANTHROPIC_EXTRACTOR_MODEL;
    delete process.env.ANTHROPIC_RESPONDER_MODEL;
    const p = getProvider();
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.resolve('responder').modelId).toBe('claude-sonnet-5-5');
  });

  it('maps OpenRouter model purposes when selected', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    delete process.env.OPENROUTER_EXTRACTOR_MODEL;
    delete process.env.OPENROUTER_RESPONDER_MODEL;
    const p = getProvider();
    expect(p).toBeInstanceOf(OpenRouterProvider);
    expect(p.resolve('extractor').modelId).toBe('google/gemini-2.5-flash');
    expect(p.resolve('responder').modelId).toBe('google/gemini-2.5-pro');
  });

  it('selects Anthropic without requiring an OpenRouter key', () => {
    process.env.LLM_PROVIDER = 'anthropic';
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'anthropic-test';
    delete process.env.ANTHROPIC_EXTRACTOR_MODEL;
    delete process.env.ANTHROPIC_RESPONDER_MODEL;
    const p = getProvider();
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.resolve('extractor').modelId).toBe('claude-haiku-5-5');
    expect(p.resolve('responder').modelId).toBe('claude-sonnet-5-5');
  });

  it.each(['', 'openai', ' Anthropic '])('rejects invalid LLM_PROVIDER %j', (value) => {
    process.env.LLM_PROVIDER = value;
    expect(() => getProvider()).toThrow(/LLM_PROVIDER must be/);
  });

  it('rejects a missing selected-provider key without revealing values', () => {
    process.env.LLM_PROVIDER = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getProvider()).toThrow(
      'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic.',
    );
  });

  it('uses independent per-purpose overrides for each provider', () => {
    process.env.OPENROUTER_EXTRACTOR_MODEL = '  vendor/fast-v2  ';
    process.env.OPENROUTER_RESPONDER_MODEL = 'vendor/strong-v3';
    const openRouter = new OpenRouterProvider('test-key');
    expect(openRouter.resolve('extractor').modelId).toBe('vendor/fast-v2');
    expect(openRouter.resolve('responder').modelId).toBe('vendor/strong-v3');

    process.env.ANTHROPIC_EXTRACTOR_MODEL = ' claude-opus-4-1 ';
    process.env.ANTHROPIC_RESPONDER_MODEL = 'claude-sonnet-5-5';
    const anthropic = new AnthropicProvider('test-key');
    expect(anthropic.resolve('extractor').modelId).toBe('claude-opus-4-1');
    expect(anthropic.resolve('responder').modelId).toBe('claude-sonnet-5-5');
  });

  it('captures overrides at provider construction and ignores inactive-provider values', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    process.env.OPENROUTER_EXTRACTOR_MODEL = 'vendor/initial';
    process.env.ANTHROPIC_EXTRACTOR_MODEL = 'not-an-anthropic-model';
    process.env.ANTHROPIC_RESPONDER_MODEL = '   ';

    const selected = getProvider();
    expect(selected.resolve('extractor').modelId).toBe('vendor/initial');
    process.env.OPENROUTER_EXTRACTOR_MODEL = 'vendor/updated';
    expect(selected.resolve('extractor').modelId).toBe('vendor/initial');
    expect(new OpenRouterProvider('test-key').resolve('extractor').modelId).toBe('vendor/updated');
  });

  it.each([
    ['OPENROUTER_EXTRACTOR_MODEL', '   ', OpenRouterProvider],
    ['OPENROUTER_RESPONDER_MODEL', 'claude-sonnet-5-5', OpenRouterProvider],
    ['ANTHROPIC_EXTRACTOR_MODEL', '', AnthropicProvider],
    ['ANTHROPIC_RESPONDER_MODEL', 'google/gemini-2.5-pro', AnthropicProvider],
  ])('rejects invalid model configuration in %s', (variable, value, ProviderClass) => {
    process.env[variable] = value;
    expect(() => new ProviderClass('test-key')).toThrow(variable);
  });

  it('does not construct LangSmith wrappers in production for either provider', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.LANGSMITH_TRACING = 'true';
    process.env.OPENROUTER_API_KEY = 'openrouter-test';
    new OpenRouterProvider('openrouter-test');
    const anthropic = new AnthropicProvider('anthropic-test').resolve('responder').client;
    vi.stubGlobal('fetch', vi.fn(async () => anthropicTextResponse()));
    await anthropic.chat.completions.create({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    });
    expect(spies.wrapOpenAI).not.toHaveBeenCalled();
    expect(spies.traceable).not.toHaveBeenCalled();
  });

  it('enables mocked LangSmith tracing in development for both providers', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.LANGSMITH_TRACING = 'true';
    new OpenRouterProvider('openrouter-test');
    const anthropic = new AnthropicProvider('anthropic-test').resolve('responder').client;
    vi.stubGlobal('fetch', vi.fn(async () => anthropicTextResponse()));
    await anthropic.chat.completions.create({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    });
    expect(spies.wrapOpenAI).toHaveBeenCalledTimes(1);
    expect(spies.traceable).toHaveBeenCalledTimes(1);
  });

  it('translates a function call through the OpenRouter protocol adapter', async () => {
    process.env.OPENROUTER_EXTRACTOR_MODEL = 'vendor/extractor-v7';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe('vendor/extractor-v7');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_test',
          model: 'vendor/extractor-v7',
          object: 'chat.completion',
          created: 1,
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tc1',
                type: 'function',
                function: { name: 'extract', arguments: '{"ok":true}' },
              }],
            },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolved = new OpenRouterProvider('key').resolve('extractor');
    const result = await resolved.client.chat.completions.create({
      model: resolved.modelId,
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 80,
      tools: [{
        type: 'function',
        function: { name: 'extract', parameters: { type: 'object' } },
      }],
      tool_choice: { type: 'function', function: { name: 'extract' } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"ok":true}');
    expect(result.usage?.prompt_tokens).toBe(5);
  });

  it('marks one cache breakpoint at the end of the system prompt for anthropic/* only, and surfaces cache usage', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'c', model: 'anthropic/claude-haiku-5.5', object: 'chat.completion', created: 1,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104, cost: 0.001, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const client = new OpenRouterProvider('key').resolve('extractor').client;
    const messages = [{ role: 'system' as const, content: 'static' }, { role: 'system' as const, content: 'tail' }, { role: 'user' as const, content: 'hi' }];
    const result = await client.chat.completions.create({ model: 'anthropic/claude-haiku-5.5', messages });
    await client.chat.completions.create({ model: 'google/gemini-2.5-flash', messages });

    expect(bodies[0].messages[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'static', cache_control: { type: 'ephemeral' } }] });
    expect(bodies[0].messages[1]).toEqual({ role: 'system', content: 'tail' });
    expect(JSON.stringify(bodies[0]).match(/cache_control/g)).toHaveLength(1);
    expect(bodies[1].messages[0]).toEqual({ role: 'system', content: 'static' });
    expect(JSON.stringify(bodies[1])).not.toContain('cache_control');
    expect(result.usage).toMatchObject({ cached_tokens: 80, cache_write_tokens: 10, cost: 0.001 });
  });

  it('sends the configured Anthropic model unchanged', async () => {
    process.env.ANTHROPIC_RESPONDER_MODEL = 'claude-opus-4-1';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe('claude-opus-4-1');
      return anthropicTextResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = new AnthropicProvider('test-key').resolve('responder');
    await resolved.client.chat.completions.create({
      model: resolved.modelId,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('Anthropic Messages translation', () => {
  it('sends system as separate blocks (cache on the first) and surfaces cache read/write tokens', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'm', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 },
      }), { status: 200 });
    }));
    const client = new AnthropicProvider('k').resolve('extractor').client;
    const result = await client.chat.completions.create({
      model: 'claude-haiku-5-5', messages: [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'x' }],
    });
    // Static first block carries the only breakpoint; the per-turn tail block has none.
    expect(sent.system).toEqual([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b' }]);
    expect(result.usage).toMatchObject({ prompt_tokens: 100, cached_tokens: 70, cache_write_tokens: 20 });
  });

  it('maps forced tools, uses compatible model options, usage and truncation', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
        model: 'claude-haiku-5-5', max_tokens: 512,
        system: [{ type: 'text', text: 'extract', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'input' }],
        tool_choice: { type: 'tool', name: 'extract' },
      }));
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('temperature');
      return new Response(JSON.stringify({
        id: 'msg_test', model: 'claude-haiku-5-5-20260601', stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'extract', input: { x: 1 } }],
        usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new AnthropicProvider('secret').resolve('extractor').client;
    const result = await client.chat.completions.create({
      model: 'claude-haiku-5-5', messages: [{ role: 'system', content: 'extract' }, { role: 'user', content: 'input' }],
      temperature: 0, max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'extract', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'extract' } },
    });
    expect(result.choices[0].finish_reason).toBe('length');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"x":1}');
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cached_tokens: 2, cache_write_tokens: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sets Sonnet between_tools, combines adjacent same-role turns, returns text and effective model', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: 'between_tools' });
      expect(body.messages).toEqual([{ role: 'user', content: 'first\nsecond' }]);
      expect(body).not.toHaveProperty('temperature');
      return new Response(JSON.stringify({
        id: 'msg_2',
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 2, output_tokens: 3 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new AnthropicProvider('secret').resolve('responder').client.chat.completions.create({
      model: 'claude-sonnet-5-5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
      temperature: 0.7,
      max_tokens: 1800,
    });
    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.choices[0].message.content).toBe('done');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('rejects unsupported tool choice and sanitizes upstream error details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'includes secret value',
      },
    }), { status: 400 })));
    const client = new AnthropicProvider('secret').resolve('extractor').client;
    await expect(client.chat.completions.create({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'x' }],
      tool_choice: { type: 'any' } as never,
    })).rejects.toThrow(/Unsupported Anthropic tool_choice/);
    await expect(client.chat.completions.create({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'x' }],
    })).rejects.toThrow('Provider call failed: request_rejected (400).');
  });

  it('maps common auto, none, and required tool choices', async () => {
    const toolChoices: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      toolChoices.push(body.tool_choice);
      return new Response(JSON.stringify({
        id: 'choice-test',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    }));
    const client = new AnthropicProvider('secret').resolve('extractor').client;
    const choices = ['auto', 'none', 'required'] as const;

    for (const choice of choices) {
      await client.chat.completions.create({
        model: 'claude-haiku-5-5',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', function: { name: 'tool', parameters: { type: 'object' } } }],
        tool_choice: choice,
      });
    }

    expect(toolChoices).toEqual([
      { type: 'auto' },
      { type: 'none' },
      { type: 'any' },
    ]);
  });

  it('rejects unsupported message and strict-tool extension fields', async () => {
    const client = new AnthropicProvider('secret').resolve('extractor').client;
    const messageWithToolCalls = {
      role: 'user',
      content: 'x',
      tool_calls: [],
    } as unknown as ChatRequest['messages'][number];
    await expect(client.chat.completions.create({
      model: 'claude-haiku-5-5',
      messages: [messageWithToolCalls],
    })).rejects.toThrow(/does not support message fields: tool_calls/);
    await expect(client.chat.completions.create({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: { name: 'tool', parameters: { type: 'object' }, strict: true },
      }],
    })).rejects.toThrow(/does not support function tool fields: strict/);
  });

  it('never sends an OpenRouter slug to Anthropic or a Claude ID to OpenRouter', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const anthropic = new AnthropicProvider('secret').resolve('responder').client;
    await expect(anthropic.chat.completions.create({
      model: 'google/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'x' }],
    })).rejects.toThrow('Anthropic provider requires a direct claude-* model ID.');
    await expect(anthropic.chat.completions.create({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'x' }],
    })).rejects.toThrow(/direct claude-\* model ID/);
    const openRouter = new OpenRouterProvider('secret').resolve('responder').client;
    await expect(openRouter.chat.completions.create({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'x' }],
    })).rejects.toThrow('OpenRouter provider requires a provider/model slug.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables Haiku thinking for text replies but keeps its default for tool requests', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return anthropicTextResponse();
    }));
    const client = new AnthropicProvider('secret').resolve('extractor').client;
    await client.chat.completions.create({
      model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }], max_tokens: 10,
    });
    await client.chat.completions.create({
      model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }], max_tokens: 10,
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    });
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(bodies[1]).not.toHaveProperty('thinking');
  });

  it('ignores thinking blocks and normalizes every tool_use block into a function call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_thinking',
      model: 'claude-haiku-5-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Listo.' },
        { type: 'tool_use', id: 't1', name: 'submit', input: { nombre: 'Café Ñandú', ok: true } },
        { type: 'tool_use', id: 't2', name: 'submit', input: {} },
      ],
      usage: { input_tokens: 3, output_tokens: 7 },
    }), { status: 200 })));
    const result = await new AnthropicProvider('secret').resolve('extractor').client.chat.completions.create({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'submit', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    });
    const [choice] = result.choices;
    expect(choice.message.content).toBe('Listo.');
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls?.map((call) => JSON.parse(call.function.arguments))).toEqual([
      { nombre: 'Café Ñandú', ok: true },
      {},
    ]);
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 });
  });

  it('adds a final user turn for empty or assistant-ending histories and rejects Sonnet forced tools', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages.at(-1)).toEqual({
        role: 'user',
        content: 'Continúa siguiendo las instrucciones del sistema.',
      });
      return new Response(JSON.stringify({
        id: 'msg_3',
        model: body.model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new AnthropicProvider('secret').resolve('responder').client;
    await client.chat.completions.create({ model: 'claude-sonnet-5-5', messages: [], max_tokens: 10 });
    await client.chat.completions.create({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'assistant', content: 'earlier' }],
      max_tokens: 10,
    });
    await expect(client.chat.completions.create({
      model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }], max_tokens: 10,
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    })).rejects.toThrow(/does not support forced tool use/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
