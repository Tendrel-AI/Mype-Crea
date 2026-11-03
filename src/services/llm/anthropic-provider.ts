import { traceable } from 'langsmith/traceable';
import type {
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ChatToolChoice,
  IChatClient,
  ILLMProvider,
  ModelPurpose,
  ProviderModelIds,
  ResolvedModel,
} from './types';
import { isAnthropicModelId, readModelOverride } from './model-config';
import { ProviderCallError, providerErrorFromStatus, providerErrorFromUnknown } from './provider-error';

const DEFAULT_MODEL_BY_PURPOSE: Readonly<Record<ModelPurpose, string>> = {
  extractor: 'claude-haiku-5-5',
  responder: 'claude-sonnet-5-5',
  naming: 'claude-haiku-5-5',
};
const API_URL = 'https://api.anthropic.com/v1/messages';
const REQUEST_TIMEOUT_MS = 60_000;

interface AnthropicResponse {
  readonly id: string;
  readonly model: string;
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly name?: string;
    readonly input?: unknown;
  }>;
  readonly stop_reason: string | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AnthropicProvider implements ILLMProvider {
  private readonly client: IChatClient;
  private readonly modelByPurpose: Readonly<Record<ModelPurpose, string>>;

  constructor(apiKey: string, modelIds?: ProviderModelIds) {
    this.modelByPurpose = modelIds === undefined
      ? {
          extractor: readModelOverride(
            'ANTHROPIC_EXTRACTOR_MODEL',
            DEFAULT_MODEL_BY_PURPOSE.extractor,
            isAnthropicModelId,
          ),
          responder: readModelOverride(
            'ANTHROPIC_RESPONDER_MODEL',
            DEFAULT_MODEL_BY_PURPOSE.responder,
            isAnthropicModelId,
          ),
          naming: DEFAULT_MODEL_BY_PURPOSE.naming,
        }
      : {
          extractor: explicitModel(modelIds.extractor, DEFAULT_MODEL_BY_PURPOSE.extractor),
          responder: explicitModel(modelIds.responder, DEFAULT_MODEL_BY_PURPOSE.responder),
          naming: explicitModel(modelIds.naming, DEFAULT_MODEL_BY_PURPOSE.naming),
        };
    this.client = new AnthropicChatClient(apiKey);
  }

  resolve(purpose: ModelPurpose): ResolvedModel {
    return {
      client: this.client,
      modelId: this.modelByPurpose[purpose],
      purpose,
      provider: 'anthropic',
    };
  }
}

class AnthropicChatClient implements IChatClient {
  readonly chat = {
    completions: {
      create: (params: ChatRequest) => this.create(params),
    },
  };

  constructor(private readonly apiKey: string) {}

  private async create(params: ChatRequest): Promise<ChatCompletion> {
    assertSupportedRequest(params);
    // Fail before any network I/O if a caller passes an OpenRouter slug or any
    // other non-Claude ID; the direct API must only ever receive claude-* IDs.
    if (!isAnthropicModelId(params.model)) {
      throw new Error('Anthropic provider requires a direct claude-* model ID.');
    }
    const { system, messages } = toAnthropicMessages(params.messages);

    // Anthropic requires a final user turn. Direct adapter/eval callers can
    // supply no history or end on an assistant turn, so add a neutral turn
    // that asks the model to follow the existing system instructions.
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      messages.push({
        role: 'user',
        content: 'Continúa siguiendo las instrucciones del sistema.',
      });
    }

    const tools = params.tools?.map(toAnthropicTool);
    const toolChoice = params.tool_choice === undefined
      ? undefined
      : toAnthropicToolChoice(params.tool_choice);
    if (
      params.model.startsWith('claude-sonnet-5-5') &&
      (toolChoice?.type === 'tool' || toolChoice?.type === 'any')
    ) {
      throw new Error(
        'Claude Sonnet 5.5 does not support forced tool use; use Haiku 5.5 for forced-tool tasks.',
      );
    }

    const thinking = thinkingConfig(params.model, Boolean(tools?.length));
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.max_tokens ?? 1024,
      system,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(thinking ? { thinking } : {}),
    };

    const invoke = async (input: Record<string, unknown>) =>
      this.sendMessage(input);
    const traced = process.env.LANGSMITH_TRACING === 'true' &&
      process.env.NODE_ENV !== 'production'
      ? traceable(invoke, { name: 'anthropic.messages.create', run_type: 'llm' })
      : invoke;

    return fromAnthropicResponse(await traced(body));
  }

  private async sendMessage(input: Record<string, unknown>): Promise<AnthropicResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(API_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        });
      } catch (error) {
        throw providerErrorFromUnknown(error);
      }
      if (!response.ok) {
        throw providerErrorFromStatus(response.status);
      }
      try {
        return await response.json() as AnthropicResponse;
      } catch {
        throw new ProviderCallError('invalid_response', response.status);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Keep up-front thinking out of short text replies so it cannot consume the
 * output cap. Sonnet 5.5 rejects `disabled`; `between_tools` is its lowest
 * setting (valid at its default `high` effort). Haiku 5.5 accepts `disabled`
 * at its default `medium` effort; tool requests keep its documented default
 * (forced tool calls return the tool call without a thinking block).
 */
function thinkingConfig(model: string, hasTools: boolean): Record<string, unknown> | undefined {
  if (model.startsWith('claude-sonnet-5-5')) return { type: 'between_tools' };
  if (model.startsWith('claude-haiku-5-5') && !hasTools) return { type: 'disabled' };
  return undefined;
}

function explicitModel(model: string | undefined, fallback: string): string {
  const value = model ?? fallback;
  if (!isAnthropicModelId(value)) throw new Error('Explicit Anthropic model ID is malformed.');
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
      `Anthropic provider does not support request fields: ${unsupported.join(', ')}.`,
    );
  }
}

function toAnthropicMessages(input: ReadonlyArray<ChatMessage>): {
  system: string;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of input) {
    const unsupported = Object.keys(message).filter(
      (key) => key !== 'role' && key !== 'content',
    );
    if (unsupported.length) {
      throw new Error(
        `Anthropic provider does not support message fields: ${unsupported.join(', ')}.`,
      );
    }

    if (message.role === 'system' || message.role === 'developer') {
      system.push(message.content);
      continue;
    }

    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error(`Anthropic provider does not support message role: ${message.role}.`);
    }

    const previous = messages[messages.length - 1];
    if (previous?.role === message.role) {
      previous.content += `\n${message.content}`;
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }

  return { system: system.join('\n\n'), messages };
}

function toAnthropicTool(tool: Record<string, unknown>): Record<string, unknown> {
  const extraToolFields = Object.keys(tool).filter(
    (key) => key !== 'type' && key !== 'function',
  );
  if (extraToolFields.length) {
    throw new Error(
      `Anthropic provider does not support tool fields: ${extraToolFields.join(', ')}.`,
    );
  }
  if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') {
    throw new Error('Anthropic provider supports function tools only.');
  }

  const fn = tool.function as Record<string, unknown>;
  const extraFunctionFields = Object.keys(fn).filter(
    (key) => !['name', 'description', 'parameters'].includes(key),
  );
  if (extraFunctionFields.length) {
    throw new Error(
      `Anthropic provider does not support function tool fields: ${extraFunctionFields.join(', ')}.`,
    );
  }
  if (typeof fn.name !== 'string' || !fn.parameters || typeof fn.parameters !== 'object') {
    throw new Error('Anthropic function tools require a name and JSON schema.');
  }

  return {
    name: fn.name,
    description: typeof fn.description === 'string' ? fn.description : '',
    input_schema: fn.parameters,
  };
}

function toAnthropicToolChoice(choice: ChatToolChoice): Record<string, unknown> {
  if (choice === 'auto' || choice === 'none') return { type: choice };
  if (choice === 'required') return { type: 'any' };

  if (choice.type === 'function') {
    const extraChoiceFields = Object.keys(choice).filter(
      (key) => key !== 'type' && key !== 'function',
    );
    const extraFunctionFields = Object.keys(choice.function).filter(
      (key) => key !== 'name',
    );
    if (extraChoiceFields.length || extraFunctionFields.length) {
      throw new Error('Anthropic provider does not support tool_choice extension fields.');
    }
    return { type: 'tool', name: choice.function.name };
  }
  if (choice.type === 'auto' || choice.type === 'none') {
    const extraFields = Object.keys(choice).filter((key) => key !== 'type');
    if (extraFields.length) {
      throw new Error('Anthropic provider does not support tool_choice extension fields.');
    }
    return { type: choice.type };
  }
  if (choice.type === 'required') {
    const extraFields = Object.keys(choice).filter((key) => key !== 'type');
    if (extraFields.length) {
      throw new Error('Anthropic provider does not support tool_choice extension fields.');
    }
    return { type: 'any' };
  }

  throw new Error('Unsupported Anthropic tool_choice shape.');
}

function fromAnthropicResponse(response: AnthropicResponse): ChatCompletion {
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const toolCalls = response.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      type: 'function' as const,
      function: {
        name: block.name ?? '',
        arguments: JSON.stringify(block.input ?? {}),
      },
    }));

  return {
    id: response.id,
    model: response.model,
    choices: [{
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: normalizeStopReason(response.stop_reason),
    }],
    usage: {
      prompt_tokens: response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens +
        response.usage.output_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
    },
  };
}

function normalizeStopReason(reason: string | null): string | null {
  switch (reason) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    case 'end_turn': return 'stop';
    default: return reason;
  }
}

