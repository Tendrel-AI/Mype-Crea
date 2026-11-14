/**
 * Repository factory. The only legal way for application code to touch the DB.
 *
 * Per docs/agents/database.md, every repository method captures the
 * tenant (and user, when needed) via this closure — there is no parameter-less
 * overload, no admin escape hatch on this factory. Tenant-admin operations
 * use a separately-named factory that explicitly logs access.
 */
import { agentTasksRepo, type AgentTasksRepo } from './agent-tasks';
import { approvalsRepo, type ApprovalsRepo } from './approvals';
import { refinementsRepo, type RefinementsRepo } from './refinements';
import { conversationsRepo, type ConversationsRepo } from './conversations';
import { conversationPromptsRepo, type ConversationPromptsRepo } from './conversation-prompts';
import { conversationTraceRepo, type ConversationTraceRepo } from './conversation-trace';
import { deliverablesRepo, type DeliverablesRepo } from './deliverables';
import { deliverableFeedbackRepo, type DeliverableFeedbackRepo } from './deliverable-feedback';
import { llmCallsRepo, type LlmCallsRepo } from './llm-calls';
import { identityRepo, type IdentityRepo } from './identity';
import { aiConfigRepo, type AiConfigRepo, type RepositoryActor } from './ai-config';
import { aiEventsRepo, aiTurnsRepo, type AiEventsRepo, type AiTurnsRepo } from './ai-turns';
import { messagesRepo, type MessagesRepo } from './messages';
import { termsAcceptancesRepo, type TermsAcceptancesRepo } from './terms-acceptances';
import { creditsRepo, type CreditsRepo } from './credits';
import { forecastRepo, type ForecastRepo } from './forecast';
import { usageRepo, type UsageRepo } from './usage';
import { writeRejectionsRepo, type WriteRejectionsRepo } from './write-rejections';
import { brandsRepo, type BrandsRepo } from './brands';
import { brandFilesRepo, type BrandFilesRepo } from './brand-files';
import { ownCandidatesRepo, type OwnCandidatesRepo } from './own-candidates';
import { limitsRepo, type LimitsRepo } from './limits';
import { productsRepo, type ProductsRepo } from './products';
import { tenantAccountsRepo, type TenantAccountsRepo } from './tenant-accounts';
import { tenantAnalyticsRepo, type TenantAnalyticsRepo } from './tenant-analytics';
import type { Tenant, User } from '../db/with-transaction';

export interface Repos {
  readonly conversations: ConversationsRepo;
  readonly conversationPrompts: ConversationPromptsRepo;
  readonly messages: MessagesRepo;
  readonly agentTasks: AgentTasksRepo;
  readonly deliverables: DeliverablesRepo;
  readonly deliverableFeedback: DeliverableFeedbackRepo;
  readonly llmCalls: LlmCallsRepo;
  readonly aiConfig: AiConfigRepo;
  readonly aiTurns: AiTurnsRepo;
  readonly approvals: ApprovalsRepo;
  readonly refinements: RefinementsRepo;
  readonly termsAcceptances: TermsAcceptancesRepo;
  readonly usage: UsageRepo;
  readonly credits: CreditsRepo;
  readonly forecast: ForecastRepo;
  readonly writeRejections: WriteRejectionsRepo;
  readonly tenantAccounts: TenantAccountsRepo;
  readonly tenantAnalytics: TenantAnalyticsRepo;
  readonly brands: BrandsRepo;
  readonly products: ProductsRepo;
  readonly limits: LimitsRepo;
  readonly brandFiles: BrandFilesRepo;
  readonly ownCandidates: OwnCandidatesRepo;
  readonly trace: ConversationTraceRepo;
}

export function repos(tenant: Tenant, user: User, actor?: RepositoryActor): Repos {
  return {
    conversations: conversationsRepo(tenant, user),
    conversationPrompts: conversationPromptsRepo(tenant, user),
    messages: messagesRepo(tenant, user),
    agentTasks: agentTasksRepo(tenant),
    deliverables: deliverablesRepo(tenant, user),
    deliverableFeedback: deliverableFeedbackRepo(tenant, user),
    llmCalls: llmCallsRepo(tenant, user),
    aiConfig: aiConfigRepo(tenant, user, actor),
    aiTurns: aiTurnsRepo(tenant, user, actor),
    approvals: approvalsRepo(tenant, user),
    refinements: refinementsRepo(tenant, user),
    termsAcceptances: termsAcceptancesRepo(tenant, user),
    usage: usageRepo(tenant, user),
    credits: creditsRepo(tenant, user),
    forecast: forecastRepo(tenant, user),
    writeRejections: writeRejectionsRepo(tenant, user),
    tenantAccounts: tenantAccountsRepo(tenant, user),
    tenantAnalytics: tenantAnalyticsRepo(tenant, user),
    brands: brandsRepo(tenant, user),
    products: productsRepo(tenant, user),
    limits: limitsRepo(tenant, user),
    brandFiles: brandFilesRepo(tenant, user),
    ownCandidates: ownCandidatesRepo(tenant, user),
    trace: conversationTraceRepo(tenant, user, actor),
  };
}

/**
 * System-scoped factory for callers that don't have a User in scope (e.g. a
 * background worker draining the agent_tasks queue, or an LLM call made
 * without an attributable user). Exposes only the tables that allow user_id
 * to be NULL or that are tenant-scoped only.
 */
export interface SystemRepos {
  readonly agentTasks: AgentTasksRepo;
  readonly llmCalls: LlmCallsRepo;
  readonly identity?: IdentityRepo;
  readonly aiEvents?: AiEventsRepo;
}

export function systemRepos(tenant: Tenant): SystemRepos {
  return {
    agentTasks: agentTasksRepo(tenant),
    llmCalls: llmCallsRepo(tenant, undefined),
    identity: identityRepo(tenant),
    aiEvents: aiEventsRepo(tenant),
  };
}

export type { Tenant, User } from '../db/with-transaction';
