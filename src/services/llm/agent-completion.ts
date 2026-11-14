/**
 * LLM completions for agent handlers (KAN-31 name-agent, KAN-32 tagline-agent).
 *
 * The chat path runs its calls through the AI-config runtime (`runPurpose`), which is bound to
 * a chat turn (turn id, owner token, attempt rows) and to the extractor/responder purposes of a
 * frozen release. An agent task has no chat turn, so it cannot use that runtime. It still uses
 * the same pieces for every call:
 *   - the model comes from `getProvider().resolve(purpose)`;
 *   - the call goes through `usageGatedCompletion` (the KAN-43 gate shared with `captureAttempt`):
 *     reserve, call, settle, validate. The ledger belongs to the conversation owner, and the gate
 *     fails closed, like images;
 *   - the call is audited through `withLlmLogging` (an `llm_calls` row with the purpose and the
 *     prompt version).
 * Failures become typed `TaskError`s, so the card shows the right copy and recovery buttons.
 *
 * Same singleton pattern as `src/services/image`: `getAgentLlm()`, plus `setAgentLlm()` /
 * `resetAgentLlm()` for tests.
 */
import type { ConversationId, TaskId, UUID } from '../../core/contracts';
import { TaskError, type TaskErrorKind } from '../../core/task-errors';
import { repos, systemRepos } from '../../repos';
import { getConversationOwnerUserId } from '../../repos/conversations';
import { isProviderEnvEnabled } from '../ai-config/provider-registry';
import { usageGatedCompletion } from '../ai-config/execution';
import type { ProviderId } from '../ai-config/manifest';
import { loggerFor } from '../logger';
import { assertOwnerActive, type OwnerActiveCheck } from '../account-status';
import { withLlmLogging } from '../llm-logger';
import { UsageLimitError, type UsageLedger } from '../usage/gateway';
import { getProvider } from './index';
import { ProviderCallError, type ProviderFailureCategory } from './provider-error';
import type { ChatCompletion, ChatRequest, IChatClient, ILLMProvider, ModelPurpose } from './types';

const log = loggerFor('service.agent-llm');

export interface AgentCompletionRequest {
  readonly purpose: ModelPurpose;
  /** Recorded on the `llm_calls` row; bump it when the prompt or the tool schema changes. */
  readonly promptVersion: string;
  /** Everything but the model, which the provider resolves for the purpose. */
  readonly request: Pick<ChatRequest, 'messages' | 'temperature' | 'max_tokens' | 'tools' | 'tool_choice'>;
  readonly usage: { readonly tenantId: UUID; readonly agentTaskId: string };
}

export interface AgentCompletionResult {
  readonly completion: ChatCompletion;
  readonly provider: ProviderId;
  readonly model: string;
}

export interface IAgentLlm {
  complete(request: AgentCompletionRequest): Promise<AgentCompletionResult>;
}

/** Who pays for the call (the conversation owner) and where it is attributed. */
export type AgentUsageResolver = (scope: AgentCompletionRequest['usage']) => Promise<{
  readonly ledger: UsageLedger;
  readonly conversationId: string;
  readonly ownerUserId: string;
}>;

/** Tenant switch from /admin/ai, read as the conversation owner. Must throw if unreadable (fail closed). */
export type ProviderAvailabilityReader = (
  scope: { readonly tenantId: UUID; readonly ownerUserId: string },
  provider: ProviderId,
) => Promise<boolean>;

const KIND_BY_PROVIDER_FAILURE: Readonly<Record<ProviderFailureCategory, TaskErrorKind>> = {
  rate_limited: 'rate_limited',
  provider_unavailable: 'provider_unavailable',
  model_unavailable: 'provider_unavailable',
  // The provider may have accepted the request before a timeout or reset.
  ambiguous: 'timeout',
  invalid_response: 'invalid_output',
  invalid_credentials: 'provider_rejected',
  request_rejected: 'provider_rejected',
};

export class AgentLlmService implements IAgentLlm {
  constructor(
    private readonly provider: () => ILLMProvider = getProvider,
    private readonly usageFor: AgentUsageResolver = resolveAgentUsage,
    private readonly availability: ProviderAvailabilityReader = readTenantAvailability,
    private readonly assertActive: OwnerActiveCheck = assertOwnerActive,
  ) {}

  async complete(input: AgentCompletionRequest): Promise<AgentCompletionResult> {
    let resolved: ReturnType<ILLMProvider['resolve']>;
    try {
      resolved = this.provider().resolve(input.purpose);
    } catch (err) {
      throw new TaskError('config_missing', 'The LLM provider is not configured.', { cause: err });
    }
    const scope = await this.usageFor(input.usage);
    // D43: checked before EACH provider call; an agent may call the model several times per task.
    await this.assertActive(input.usage.tenantId, scope.ownerUserId);
    const provider: ProviderId = resolved.provider ?? 'openrouter';
    await this.assertProviderEnabled(input.usage.tenantId, scope.ownerUserId, provider);
    const gated: IChatClient = {
      chat: {
        completions: {
          create: (params) => usageGatedCompletion(resolved.client, params, scope.ledger, {
            provider,
            conversationId: scope.conversationId,
            agentTaskId: input.usage.agentTaskId,
          }),
        },
      },
    };
    try {
      const completion = await withLlmLogging(gated, { ...input.request, model: resolved.modelId }, {
        tenant: { id: input.usage.tenantId },
        user: { id: scope.ownerUserId as UUID },
        conversationId: scope.conversationId as ConversationId,
        agentTaskId: input.usage.agentTaskId as TaskId,
        promptVersion: input.promptVersion,
        modelRevision: resolved.modelRevision,
        provider,
        purpose: input.purpose,
      });
      return { completion, provider, model: completion.model ?? resolved.modelId };
    } catch (error) {
      if (error instanceof UsageLimitError) throw new TaskError('usage_limited', error.userMessage, { cause: error });
      if (error instanceof ProviderCallError) throw new TaskError(KIND_BY_PROVIDER_FAILURE[error.category], error.message, { cause: error });
      throw error;
    }
  }

  private async assertProviderEnabled(tenantId: UUID, ownerUserId: string, provider: ProviderId): Promise<void> {
    let enabled: boolean;
    try {
      enabled = isProviderEnvEnabled(provider) && (await this.availability({ tenantId, ownerUserId }, provider));
    } catch (err) {
      enabled = false; // fail closed: an unreadable switch refuses
      log.error({ provider, err, reason: 'availability_unreadable' }, 'agent.llm.provider_check_failed');
    }
    if (!enabled) {
      log.warn({ provider, tenantId, reason: 'provider_disabled' }, 'agent.llm.provider_refused');
      throw new TaskError('provider_unavailable', 'The LLM provider is disabled.');
    }
  }
}

/** Same two switches chat honors; a refusal happens before any reservation or network call. */
async function readTenantAvailability(scope: { tenantId: UUID; ownerUserId: string }, provider: ProviderId): Promise<boolean> {
  return (await repos({ id: scope.tenantId }, { id: scope.ownerUserId as UUID }).aiConfig.getProviderAvailability(provider)).enabled;
}

/** KAN-43: an agent's LLM call is charged to the owner of the task's conversation. Fails closed. */
const resolveAgentUsage: AgentUsageResolver = async ({ tenantId, agentTaskId }) => {
  const tenant = { id: tenantId };
  const task = await systemRepos(tenant).agentTasks.findById(agentTaskId as TaskId);
  const owner = task ? await getConversationOwnerUserId(tenant, task.conversationId as ConversationId) : null;
  if (!task || !owner) throw new Error('Cannot attribute LLM usage: task or conversation owner not found.');
  return { ledger: repos(tenant, { id: owner }).usage, conversationId: task.conversationId, ownerUserId: owner };
};

let agentLlm: IAgentLlm | undefined;

export function getAgentLlm(): IAgentLlm {
  agentLlm ??= new AgentLlmService();
  return agentLlm;
}

/** Test hook: swap in a fake, or pass undefined to clear it. */
export function setAgentLlm(llm: IAgentLlm | undefined): void {
  agentLlm = llm;
}

/** Test hook: drop the cached singleton so the next `getAgentLlm()` rebuilds. */
export function resetAgentLlm(): void {
  agentLlm = undefined;
}
