/** OpenRouter-backed provider with an OpenAI SDK transport. */
import OpenAI from 'openai';
import { wrapOpenAI } from 'langsmith/wrappers';
import type {
  ChatRequest,
  ChatToolChoice,
  IChatClient,
  ILLMProvider,
  ModelPurpose,
  ProviderModelIds,
  ResolvedModel,
} from './types';
import { isOpenRouterModelId, readModelOverride } from './model-config';
import { providerErrorFromUnknown } from './provider-error';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL_BY_PURPOSE: Readonly<Record<ModelPurpose, string>> = {
  extractor: 'google/gemini-2.5-flash',
  responder: 'google/gemini-2.5-pro',
  naming: 'google/gemini-2.5-flash',
};

export class OpenRouterProvider implements ILLMProvider {
  private readonly client: IChatClient;
  private readonly modelByPurpose: Readonly<Record<ModelPurpose, string>>;

  constructor(apiKey: string, modelIds?: ProviderModelIds) {
    this.modelByPurpose = modelIds === undefined
      ? {
          extractor: readModelOverride(
            'OPENROUTER_EXTRACTOR_MODEL',
            DEFAULT_MODEL_BY_PURPOSE.extractor,
            isOpenRouterModelId,
          ),
          responder: readModelOverride(
            'OPENROUTER_RESPONDER_MODEL',
            DEFAULT_MODEL_BY_PURPOSE.responder,
            isOpenRouterModelId,
          ),
          naming: DEFAULT_MODEL_BY_PURPOSE.naming,
        }
      : {
          extractor: explicitModel(modelIds.extractor, DEFAULT_MODEL_BY_PURPOSE.extractor),
          responder: explicitModel(modelIds.responder, DEFAULT_MODEL_BY_PURPOSE.responder),
          naming: explicitModel(modelIds.naming, DEFAULT_MODEL_BY_PURPOSE.naming),
        };
    const openAiClient = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
    const tracedClient = isLangSmithTracingEnabled()
      ? wrapOpenAI(openAiClient)
      : openAiClient;

    this.client = {
      chat: {
        completions: {
          create: async (params) => {
            assertSupportedRequest(params);
            if (!isOpenRouterModelId(params.model)) {
              throw new Error('OpenRouter provider requires a provider/model slug.');
            }
            let response: Awaited<ReturnType<typeof tracedClient.chat.completions.create>>;
            try {
              response = await tracedClient.chat.completions.create({
                model: params.model,
                messages: toOpenRouterMessages(params.messages, supportsCacheControl(params.model)),
                ...(typeof params.temperature === 'number'
                  ? { temperature: params.temperature }
                  : {}),
                ...(typeof params.max_tokens === 'number'
                  ? { max_tokens: params.max_tokens }
                  : {}),
                ...(params.tools
                  ? { tools: toOpenRouterTools(params.tools) }
                  : {}),
                ...(params.tool_choice !== undefined
                  ? { tool_choice: toOpenRouterToolChoice(params.tool_choice) }
                  : {}),
              });
            } catch (error) {
              throw providerErrorFromUnknown(error);
            }
            return fromOpenRouterResponse(response);
          },
        },
      },
    };
  }

  resolve(purpose: ModelPurpose): ResolvedModel {
    return {
      client: this.client,
      modelId: this.modelByPurpose[purpose],
      purpose,
      provider: 'openrouter',
    };
  }
}

function explicitModel(model: string | undefined, fallback: string): string {
  const value = model ?? fallback;
  if (!isOpenRouterModelId(value)) throw new Error('Explicit OpenRouter model ID is malformed.');
  return value;
}

function assertSupportedRequest(params: ChatRequest): void {
  const supported = new Set([
    'model',
    'messages',
    'temperature',
    'max_tokens',
    'tools',
    'tool_choice',
  ]);
  const unsupported = Object.keys(params).filter((key) => !supported.has(key));
  if (unsupported.length) {
    throw new Error(
      `OpenRouter provider does not support request fields: ${unsupported.join(', ')}.`,
    );
  }
}

function toOpenRouterMessages(
  messages: ChatRequest['messages'],
  cache: boolean,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // One breakpoint on the last system message: tools + system render before the turn messages.
  const lastSystem = cache
    ? messages.reduce((last, m, i) => (m.role === 'system' || m.role === 'developer' ? i : last), -1)
    : -1;
  return messages.map((message, index) => {
    const unsupported = Object.keys(message).filter(
      (key) => key !== 'role' && key !== 'content',
    );
    if (unsupported.length) {
      throw new Error(
        `OpenRouter provider does not support message fields: ${unsupported.join(', ')}.`,
      );
    }

    if (
      message.role !== 'system' &&
      message.role !== 'developer' &&
      message.role !== 'user' &&
      message.role !== 'assistant'
    ) {
      throw new Error(`OpenRouter provider does not support message role: ${message.role}.`);
    }
    if (index === lastSystem && message.role === 'system') {
      // `cache_control` is an OpenRouter extension on text parts the SDK types do not know.
      return {
        role: 'system',
        content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }],
      } as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }
    return { role: message.role, content: message.content };
  });
}

/** Only Anthropic models need explicit cache markers; Gemini/DeepSeek/MiniMax cache implicitly. */
function supportsCacheControl(model: string): boolean {
  return model.startsWith('anthropic/');
}

function toOpenRouterTools(
  input: ReadonlyArray<Record<string, unknown>>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return input.map((tool) => {
    const extraToolFields = Object.keys(tool).filter(
      (key) => key !== 'type' && key !== 'function',
    );
    if (extraToolFields.length) {
      throw new Error(
        `OpenRouter provider does not support tool fields: ${extraToolFields.join(', ')}.`,
      );
    }
    if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') {
      throw new Error('OpenRouter supports function tools only.');
    }

    const fn = tool.function as Record<string, unknown>;
    const extraFunctionFields = Object.keys(fn).filter(
      (key) => !['name', 'description', 'parameters'].includes(key),
    );
    if (extraFunctionFields.length) {
      throw new Error(
        `OpenRouter provider does not support function tool fields: ${extraFunctionFields.join(', ')}.`,
      );
    }
    if (typeof fn.name !== 'string' || !isRecord(fn.parameters)) {
      throw new Error('OpenRouter function tools require a name and JSON schema.');
    }

    return {
      type: 'function',
      function: {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters,
      },
    };
  });
}

function toOpenRouterToolChoice(
  choice: ChatToolChoice,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice.type === 'function') {
    const extraChoiceFields = Object.keys(choice).filter(
      (key) => key !== 'type' && key !== 'function',
    );
    const extraFunctionFields = Object.keys(choice.function).filter((key) => key !== 'name');
    if (extraChoiceFields.length || extraFunctionFields.length) {
      throw new Error('OpenRouter provider does not support tool_choice extension fields.');
    }
    return {
      type: 'function',
      function: { name: choice.function.name },
    };
  }
  const extraFields = Object.keys(choice).filter((key) => key !== 'type');
  if (extraFields.length) {
    throw new Error('OpenRouter provider does not support tool_choice extension fields.');
  }
  return choice.type;
}

export function fromOpenRouterResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
) {
  return {
    id: response.id,
    model: response.model,
    choices: response.choices.map(({ message, finish_reason }) => ({
      message: {
        role: 'assistant' as const,
        content: message.content,
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls
                .filter((call) => call.type === 'function')
                .map((call) => ({
                  type: 'function' as const,
                  function: {
                    name: call.function.name,
                    arguments: call.function.arguments,
                  },
                })),
            }
          : {}),
      },
      finish_reason,
    })),
    usage: response.usage
      ? {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
          ...providerCost(response.usage),
          ...cacheUsage(response.usage),
        }
      : undefined,
  };
}

/** OpenRouter adds `usage.cost` (USD) beside the OpenAI fields; the SDK types do not know it. */
function providerCost(usage: object): { cost?: number } {
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { cost } : {};
}

/** Cached prompt tokens (OpenRouter `prompt_tokens_details`); absent when the provider reports none. */
function cacheUsage(usage: object): { cached_tokens?: number; cache_write_tokens?: number } {
  const details = (usage as { prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } })
    .prompt_tokens_details;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const cached = count(details?.cached_tokens);
  const written = count(details?.cache_write_tokens);
  return {
    ...(cached !== undefined ? { cached_tokens: cached } : {}),
    ...(written !== undefined ? { cache_write_tokens: written } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** LangSmith tracing stays disabled in production because prompts carry tenant data. */
function isLangSmithTracingEnabled(): boolean {
  return process.env.LANGSMITH_TRACING === 'true' && process.env.NODE_ENV !== 'production';
}
