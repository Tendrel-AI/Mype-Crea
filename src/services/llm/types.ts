/** Provider-neutral chat protocol consumed by adapters and the audit logger. */
/** `naming` (KAN-31, KAN-32): name-agent and tagline-agent candidates; it uses the extractor's default model (forced tool call). */
export type ModelPurpose = 'extractor' | 'responder' | 'naming';
export type ProviderModelIds = Partial<Record<ModelPurpose, string>>;

export type ChatMessage = {
  readonly role: 'system' | 'developer' | 'user' | 'assistant';
  readonly content: string;
};

export type ChatToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'function'; readonly function: { readonly name: string } }
  | { readonly type: 'auto' | 'none' | 'required' };

export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly tool_choice?: ChatToolChoice;
  readonly [key: string]: unknown;
}

export interface ChatToolCall {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface ChatCompletion {
  readonly id: string;
  readonly model?: string;
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: ReadonlyArray<ChatToolCall>;
    };
    readonly finish_reason: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens?: number;
  };
}

export interface IChatClient {
  readonly chat: {
    readonly completions: {
      create(params: ChatRequest): Promise<ChatCompletion>;
    };
  };
}

export interface ResolvedModel {
  readonly client: IChatClient;
  readonly modelId: string;
  readonly purpose: ModelPurpose;
  readonly provider?: 'openrouter' | 'anthropic';
  readonly modelRevision?: string;
}

export interface ILLMProvider {
  resolve(purpose: ModelPurpose): ResolvedModel;
}
