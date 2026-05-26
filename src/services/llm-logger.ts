/**
 * LLM logging service. Encapsulates the only legitimate way to call an
 * OpenAI-compatible chat completion in app code: through `withLlmLogging`,
 * which captures `response.usage`, computes latency, and persists an
 * `llm_calls` row. Controllers must not construct OpenAI client calls
 * outside this wrapper — token counts will be lost.
 *
 * Persistence failures are swallowed (logged at error level). The
 * `llm_calls` table is append-only audit data; a transient DB hiccup must
 * not break the user-visible response. The architecture skill explicitly
 * tolerates losing rows on transient failure for this table.
 */
import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
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

export async function withLlmLogging(
  client: OpenAI,
  params: ChatCompletionCreateParamsNonStreaming,
  ctx: LlmLoggingContext,
): Promise<ChatCompletion> {
  const child = log.child({
    tenantId: ctx.tenant.id,
    userId: ctx.user?.id,
    conversationId: ctx.conversationId,
    agentTaskId: ctx.agentTaskId,
    model: params.model,
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
      model: params.model,
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
