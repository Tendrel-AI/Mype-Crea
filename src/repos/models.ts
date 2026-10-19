/**
 * Domain models shared across repositories and their callers.
 *
 * These are plain TS interfaces. They do NOT import from `pg` and contain
 * no behavior — that belongs in the per-table repos. Branded UUID aliases
 * come from src/core/contracts.ts; this file does not redeclare them.
 */
import type { ConversationId, ConversationSnapshot, TaskId, UUID } from '../core/contracts';
import type { AiConfigManifestV1, JsonValue, ProviderId, Purpose } from '../services/ai-config/manifest';

// ---------------------------------------------------------------------------
// AI configuration, pinned conversations, and durable turns
// ---------------------------------------------------------------------------

export type AiReleaseStatus = 'draft' | 'frozen' | 'retired';
export type AiTurnStage =
  | 'reserved'
  | 'extracted'
  | 'effects_started'
  | 'effects_committed'
  | 'responded'
  | 'uncertain';
export type AiAttemptStatus = 'started' | 'succeeded' | 'failed' | 'uncertain';
export type AiEventKind = 'artifact' | 'task_processing' | 'decision' | 'notice';

export interface TenantAiRelease {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly name: string;
  readonly status: AiReleaseStatus;
  readonly draftVersion: number;
  readonly manifest: AiConfigManifestV1;
  readonly canonicalContent: string;
  readonly contentHash: string | null;
  readonly baseSharedReleaseId: UUID | null;
  readonly allowedOverridePaths: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SharedAiRelease {
  readonly id: UUID;
  readonly name: string;
  readonly status: AiReleaseStatus;
  readonly draftVersion: number;
  readonly manifest: AiConfigManifestV1;
  readonly canonicalContent: string;
  readonly contentHash: string | null;
  readonly allowedOverridePaths: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiReleaseActivation {
  readonly releaseId: UUID;
  readonly version: number;
  readonly updatedBy: UUID;
  readonly updatedAt: string;
}

export interface ProviderAvailability {
  readonly provider: ProviderId;
  readonly enabled: boolean;
  readonly version: number;
  readonly updatedBy: UUID | null;
}

export interface AiConversationPin {
  readonly conversationId: ConversationId;
  readonly state: 'pinned' | 'legacy_unversioned';
  readonly releaseId: UUID | null;
  readonly snapshot: ConversationSnapshot;
}

export interface AiTurnRow {
  readonly id: UUID;
  readonly userId: UUID;
  readonly conversationId: ConversationId;
  readonly requestId: UUID;
  readonly inputHash: string;
  readonly inputContent: string | null;
  readonly responseContent: string | null;
  readonly releaseId: UUID;
  readonly stage: AiTurnStage;
  readonly version: number;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly failureCategory: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AiTurnNotice {
  readonly id: UUID;
  readonly turnId: UUID;
  readonly conversationId: ConversationId;
  readonly code: string;
  readonly content: string | null;
  readonly createdAt: string;
}

export interface AiTurnAttempt {
  readonly id: UUID;
  readonly turnId: UUID;
  readonly purpose: Purpose;
  readonly attemptNumber: number;
  readonly primaryProfileId: string;
  readonly effectiveProfileId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly modelRevision: string | null;
  readonly status: AiAttemptStatus;
  readonly failureCategory: string | null;
  readonly providerStatus: number | null;
  readonly requestContent: string | null;
  readonly responseContent: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly costAmount: number | null;
  readonly costCurrency: string | null;
  readonly costSource: 'provider_reported' | 'estimated' | null;
  readonly pricingVersion: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface AiTurnEvent {
  readonly id: UUID;
  readonly eventId: string;
  readonly conversationId: ConversationId;
  readonly turnId: UUID | null;
  readonly taskId: TaskId;
  readonly kind: AiEventKind;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export interface UsageSummary {
  readonly attempts: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly unknownInputTokenAttempts: number;
  readonly unknownOutputTokenAttempts: number;
  readonly knownCost: number;
  readonly unknownCostAttempts: number;
  readonly costAccountingStatus: 'no_attempts' | 'complete' | 'partial' | 'unknown';
  readonly budgetStatus: 'unconfigured';
}

// ---------------------------------------------------------------------------
// llm_calls
// ---------------------------------------------------------------------------

export interface LlmCallInsert {
  readonly conversationId?: ConversationId;
  readonly agentTaskId?: TaskId;
  readonly model: string;
  readonly modelRevision: string;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageGenerationStatus = 'pending' | 'complete' | 'failed';

export interface MessageInsert {
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: string;
  readonly generationStatus?: MessageGenerationStatus;
}

export interface MessageRow {
  readonly id: UUID;
  readonly conversationId: ConversationId;
  readonly userId: UUID;
  readonly role: MessageRole;
  readonly content: string;
  readonly generationStatus: MessageGenerationStatus;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

export interface ListMessagesOptions {
  readonly limit?: number;
  readonly orderDescending?: boolean;
}

// ---------------------------------------------------------------------------
// agent_tasks
// ---------------------------------------------------------------------------

export type AgentTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'canceled';

export type IterationTrigger = 'user_reject' | 'user_regenerate' | 'failure';

export type ErrorCategory = 'transient' | 'content_policy' | 'permanent_bug';

export interface AgentTaskRootInsert {
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly agentCardVersion: string;
  readonly idempotencyKey: UUID;
  readonly requirementsSnapshot: Record<string, unknown>;
  readonly scheduledFor?: string;
}

export interface AgentTaskIterationInsert {
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly agentCardVersion: string;
  readonly idempotencyKey: UUID;
  readonly parentTaskId: TaskId;
  readonly iterationRootId: TaskId;
  readonly iterationNumber: number;
  readonly iterationTrigger: IterationTrigger;
  readonly requirementsSnapshot: Record<string, unknown>;
  readonly scheduledFor?: string;
}

export interface AgentTaskRow {
  readonly id: TaskId;
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly agentCardVersion: string;
  readonly status: AgentTaskStatus;
  readonly attempts: number;
  readonly idempotencyKey: UUID;
  readonly parentTaskId: TaskId | null;
  readonly iterationRootId: TaskId;
  readonly iterationNumber: number;
  readonly iterationTrigger: IterationTrigger | null;
  readonly requirementsSnapshot: Record<string, unknown>;
  readonly error: Record<string, unknown> | null;
  readonly errorCategory: ErrorCategory | null;
  readonly scheduledFor: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// deliverables
// ---------------------------------------------------------------------------

export type DeliverableKind = 'logo' | 'business_name' | 'tagline' | 'label' | 'social_pack';

export interface DeliverableInsert {
  readonly conversationId: ConversationId;
  readonly agentTaskId: TaskId;
  readonly kind: DeliverableKind;
  readonly contentUrl?: string | null;
  readonly contentInline?: Record<string, unknown> | null;
}

export interface DeliverableRow {
  readonly id: UUID;
  readonly conversationId: ConversationId;
  readonly agentTaskId: TaskId;
  readonly userId: UUID;
  readonly kind: DeliverableKind;
  readonly contentUrl: string | null;
  readonly contentInline: Record<string, unknown> | null;
  readonly selectedAt: string | null;
  readonly supersededBy: UUID | null;
  readonly createdAt: string;
}
