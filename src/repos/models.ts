/**
 * Domain models shared across repositories and their callers.
 *
 * These are plain TS interfaces. They do NOT import from `pg` and contain
 * no behavior — that belongs in the per-table repos. Branded UUID aliases
 * come from src/core/contracts.ts; this file does not redeclare them.
 */
import type { ConversationId, TaskId, UUID } from '../core/contracts';

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
