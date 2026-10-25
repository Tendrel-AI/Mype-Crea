/**
 * LLM logging service. Encapsulates the only legitimate way to call an
 * OpenAI-compatible chat completion in app code: through `withLlmLogging`,
 * which captures `response.usage`, computes latency, and persists an
 * `llm_calls` row. Controllers must not construct OpenAI client calls
 * outside this wrapper — token counts will be lost.
 *
 * Every call must state its provenance (`provider`, `purpose`): the provider is
 * the EFFECTIVE one that served the call (e.g. the fallback profile's provider on
 * a fallback attempt), taken from the resolved model, never from `LLM_PROVIDER`.
 * Judge/eval calls are eval cost and do not go through this wrapper.
 *
 * Persistence failures are swallowed (logged at error level). The
 * `llm_calls` table is append-only audit data; a transient DB hiccup must
 * not break the user-visible response. The architecture skill explicitly
 * tolerates losing rows on transient failure for this table.
 */
import type { ChatCompletion, ChatRequest, IChatClient, ModelPurpose } from './llm/types';
import type { ProviderId } from './ai-config/manifest';
import type { ConversationId, TaskId } from '../core/contracts';
import type { Tenant, User } from '../db/with-transaction';
import { systemRepos, repos } from '../repos';
import { loggerFor } from './logger';

const log = loggerFor('service.llm-logger');

export interface LlmLoggingContext {
  readonly tenant: Tenant;
  readonly user?: User;
  readonly conversationId?: ConversationId;
  readonly agentTaskId?: TaskId;
  /** Hash or semver of the system prompt; bump when the prompt changes. */
  readonly promptVersion: string;
  /** Optional caller-provided revision string; defaults to 'unknown'. */
  readonly modelRevision?: string;
}

/** Per-call provenance; required so llm_calls rows reflect what actually ran. */
export interface LlmCallProvenance {
  /** Effective provider of the resolved model that serves this call. */
  readonly provider: ProviderId;
  readonly purpose: ModelPurpose;
}

export type LlmCallContext = LlmLoggingContext & LlmCallProvenance;

export async function withLlmLogging(
  client: IChatClient,
  params: ChatRequest,
  ctx: LlmCallContext,
): Promise<ChatCompletion> {
  const child = log.child({
    tenantId: ctx.tenant.id,
    userId: ctx.user?.id,
    conversationId: ctx.conversationId,
    agentTaskId: ctx.agentTaskId,
    model: params.model,
    provider: ctx.provider,
    purpose: ctx.purpose,
  });

  child.info('llm.request.start');
  const t0 = Date.now();
  let completion: ChatCompletion;
  try {
    completion = await client.chat.completions.create(params);
  } catch (err) {
    const latencyMs = Date.now() - t0;
    child.error({ err, latencyMs }, 'llm.request.failed');
    throw err;
  }
  const latencyMs = Date.now() - t0;
  const usage = completion.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const finishReason = completion.choices[0]?.finish_reason;
  child.info(
    {
      latencyMs,
      model: completion.model ?? params.model,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      // 'length' here means the model hit max_tokens and was cut mid-output.
      // Surface it explicitly so truncations don't disappear into the void.
      finishReason,
    },
    'llm.request.complete',
  );
  if (finishReason === 'length') {
    child.warn(
      { latencyMs, outputTokens: usage.completion_tokens, maxTokens: params.max_tokens },
      'llm.request.truncated_by_max_tokens',
    );
  }

  // Persist outside the user-visible critical path.
  try {
    const repo = ctx.user
      ? repos(ctx.tenant, ctx.user).llmCalls
      : systemRepos(ctx.tenant).llmCalls;
    await repo.record({
      conversationId: ctx.conversationId,
      agentTaskId: ctx.agentTaskId,
      provider: ctx.provider,
      purpose: ctx.purpose,
      model: completion.model ?? params.model,
      modelRevision: ctx.modelRevision ?? 'unknown',
      promptVersion: ctx.promptVersion,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      latencyMs,
    });
  } catch (err) {
    child.error({ err }, 'llm.persist.failed');
    // Intentionally do not rethrow.
  }
  return completion;
}
