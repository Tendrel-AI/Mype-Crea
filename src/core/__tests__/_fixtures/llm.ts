/**
 * FakeLLMProvider — shared LLM stand-in for adapter and orchestrator tests.
 *
 * Supports both adapter shapes:
 *   - Extractor (tool-call): `scriptToolCall('submit_extracted_fields', JSON.stringify({...}))`
 *     emits a single function tool_call. Passing `null` simulates a model that
 *     declined to call the tool.
 *   - Responder (content): `scriptContent('reply text')` emits a plain assistant
 *     content message.
 *
 * Every call is captured in `captured` for assertions on the system prompt,
 * message count, and raw params. The underlying mock function is exposed as
 * `create` so callers can run `expect(provider.create).toHaveBeenCalledTimes(...)`
 * and inspect `provider.create.mock.calls[i]` for fine-grained checks.
 */
import { vi } from 'vitest';
import type OpenAI from 'openai';
import type {
  ILLMProvider,
  ModelPurpose,
  ResolvedModel,
} from '../../../services/llm/types';

export interface CapturedCall {
  readonly params: unknown;
  readonly systemPrompt: string;
  readonly messageCount: number;
}

type ScriptedResponse =
  | { readonly kind: 'tool_call'; readonly name: string; readonly toolArguments: string | null }
  | { readonly kind: 'content'; readonly content: string };

export interface FakeLLMProviderOptions {
  readonly purpose?: ModelPurpose;
  readonly modelId?: string;
}

export class FakeLLMProvider implements ILLMProvider {
  readonly captured: CapturedCall[] = [];
  readonly create: ReturnType<typeof vi.fn>;

  private response: ScriptedResponse | null = null;

  constructor(private readonly opts: FakeLLMProviderOptions = {}) {
    this.create = vi.fn(async (params: { messages?: Array<{ role: string; content: string }> }) => {
      const sys = params.messages?.find((m) => m.role === 'system')?.content ?? '';
      this.captured.push({
        params,
        systemPrompt: sys,
        messageCount: params.messages?.length ?? 0,
      });
      return this.buildResponse();
    });
  }

  /** Script a tool-call response. Returns `this` for fluent chaining in tests. */
  scriptToolCall(toolName: string, toolArguments: string | null): this {
    this.response = { kind: 'tool_call', name: toolName, toolArguments };
    return this;
  }

  /** Script a plain content response (responder pattern). */
  scriptContent(content: string): this {
    this.response = { kind: 'content', content };
    return this;
  }

  resolve(_purpose?: ModelPurpose): ResolvedModel {
    return {
      purpose: this.opts.purpose ?? 'responder',
      modelId: this.opts.modelId ?? 'fake-model',
      client: {
        chat: { completions: { create: this.create } },
      } as unknown as OpenAI,
    };
  }

  private buildResponse(): unknown {
    const r = this.response;
    if (!r) {
      throw new Error(
        'FakeLLMProvider: no response scripted. Call scriptToolCall() or scriptContent() first.',
      );
    }
    if (r.kind === 'tool_call') {
      return {
        id: 'chatcmpl-fake',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls:
                r.toolArguments === null
                  ? []
                  : [
                      {
                        id: 'call_fake_1',
                        type: 'function',
                        function: {
                          name: r.name,
                          arguments: r.toolArguments,
                        },
                      },
                    ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      };
    }
    return {
      id: 'chatcmpl-fake',
      choices: [{ message: { role: 'assistant', content: r.content } }],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    };
  }
}
