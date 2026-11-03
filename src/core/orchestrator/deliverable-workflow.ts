/**
 * MYPES Platform — Deliverable workflow store port (KAN-28)
 * ==========================================================
 *
 * The facts the pure state function needs (tasks and candidates per
 * conversation) and the two guarded writes the command path performs
 * (create a task, cancel a pending task). The core never touches
 * repositories directly; it goes through this port.
 *
 * Implementations:
 *   - `InMemoryDeliverableWorkflowStore` (below) — unit tests / in-memory core.
 *   - `PostgresDeliverableWorkflowStore` (./postgres-workflow.ts) — production,
 *     over the tenant-scoped `agent_tasks` and `deliverables` repositories.
 */

import { randomUUID } from 'node:crypto';
import type { A2AArtifact } from '../agent-types';
import type { ConversationId, DeliverableId, ISOTimestamp, TaskId } from '../contracts';
import { recordedFieldVersions, recordedUpstream } from '../deliverable-inputs';
import type { TaskErrorCategory } from '../task-errors';

export type WorkflowTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';

/** `iteration_trigger` enum values (agent_tasks). */
export type WorkflowIterationTrigger = 'user_reject' | 'user_regenerate' | 'failure';

export interface WorkflowTask {
  readonly id: TaskId;
  readonly agentId: string;
  readonly status: WorkflowTaskStatus;
  readonly errorCategory: TaskErrorCategory | null;
  /** `error.kind` of a failed task (e.g. `usage_limited`); null otherwise or when unknown. */
  readonly errorKind?: string | null;
  readonly parentTaskId: TaskId | null;
  readonly iterationRootId: TaskId;
  readonly iterationNumber: number;
  readonly iterationTrigger: WorkflowIterationTrigger | null;
  readonly createdAt: ISOTimestamp;
  /**
   * Upstream approvals the task was created under (`{ kind: deliverableId }`,
   * KAN-35). Null/absent for tasks created before KAN-35.
   */
  readonly upstreamApprovals?: Readonly<Record<string, string>> | null;
}

export interface WorkflowCandidate {
  readonly deliverableId: DeliverableId;
  readonly agentTaskId: TaskId;
  readonly kind: string;
  readonly contentUrl: string | null;
  readonly contentInline: Readonly<Record<string, unknown>> | null;
  readonly createdAt: ISOTimestamp;
  /** Brief field versions the handler recorded as used (`metadata.inputs`, KAN-35). Null/absent when none. */
  readonly inputVersions?: Readonly<Record<string, string>> | null;
}

export interface CreateTaskInput {
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly agentCardVersion: string;
  /** The command id doubles as the task's idempotency key. */
  readonly commandId: string;
  readonly requirementsSnapshot: Record<string, unknown>;
  /**
   * Present for Iterar / Reintentar; absent for a root Generar. The Postgres
   * store derives `iterationRootId` / `iterationNumber` from the parent under
   * a lock (authoritative); the in-memory store uses the values given.
   */
  readonly iteration?: {
    readonly parentTaskId: TaskId;
    readonly iterationRootId: TaskId;
    readonly iterationNumber: number;
    readonly trigger: WorkflowIterationTrigger;
  };
}

export type CreateTaskResult =
  | { readonly ok: true; readonly task: WorkflowTask }
  /** Another task for this (conversation, agent) is pending or in progress. */
  | { readonly ok: false; readonly reason: 'active_task_exists' }
  /** This command id already created a task (concurrent replay). */
  | { readonly ok: false; readonly reason: 'duplicate_command'; readonly task: WorkflowTask }
  /** This command id already created a task in ANOTHER conversation (KAN-44); nothing about it is returned. */
  | { readonly ok: false; readonly reason: 'command_id_conflict' }
  /**
   * The iteration's parent (or the refinement anchor) is no longer usable:
   * not the conversation's own task of this agent, wrong status for the
   * trigger, or the anchor is not a deliverable of the parent. The command
   * handler reports it as `stale`.
   */
  | { readonly ok: false; readonly reason: 'parent_unavailable' };

export interface RecordSettlementInput {
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly agentId: string;
  readonly deliverableKind: string;
  readonly status: 'completed' | 'failed';
  readonly artifacts: ReadonlyArray<A2AArtifact>;
  readonly deliverableIds: ReadonlyArray<DeliverableId>;
  readonly error?: { readonly kind: string; readonly message: string };
  readonly errorCategory?: TaskErrorCategory;
}

export interface IDeliverableWorkflowStore {
  listTasks(conversationId: ConversationId): Promise<ReadonlyArray<WorkflowTask>>;
  listCandidates(conversationId: ConversationId): Promise<ReadonlyArray<WorkflowCandidate>>;
  findTaskByCommandId(conversationId: ConversationId, commandId: string): Promise<WorkflowTask | null>;
  /**
   * Insert a task only if no other task of the same (conversation, agent) is
   * pending/in progress, atomically. This is the server-side guard against
   * double generation even when two commands race past validation.
   */
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  /** `pending -> canceled` only. False when the task is gone or already claimed. */
  cancelPendingTask(conversationId: ConversationId, taskId: TaskId): Promise<boolean>;
  /**
   * Persist a non-durable settlement (LocalAdapter path). The durable worker
   * path settles inside the worker and never calls this. Returns the
   * deliverable ids to announce.
   */
  recordSettlement(input: RecordSettlementInput): Promise<RecordSettlementResult>;
}

export interface RecordSettlementResult {
  /** False when the task was no longer pending/in progress (e.g. canceled): nothing was written. */
  readonly applied: boolean;
  readonly deliverableIds: ReadonlyArray<DeliverableId>;
}

/**
 * In-memory workflow store. Settlement turns each artifact into a candidate
 * (the production worker does the same with `deliverables` rows).
 */
export class InMemoryDeliverableWorkflowStore implements IDeliverableWorkflowStore {
  private readonly tasks = new Map<ConversationId, Array<WorkflowTask & { readonly commandId: string }>>();
  private readonly candidates = new Map<ConversationId, WorkflowCandidate[]>();
  private readonly requirements = new Map<TaskId, Record<string, unknown>>();
  private clock = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly newTaskId: () => TaskId = () => randomUUID() as TaskId,
  ) {}

  async listTasks(conversationId: ConversationId): Promise<ReadonlyArray<WorkflowTask>> {
    return (this.tasks.get(conversationId) ?? []).map(({ commandId: _commandId, ...task }) => task);
  }

  async listCandidates(conversationId: ConversationId): Promise<ReadonlyArray<WorkflowCandidate>> {
    return [...(this.candidates.get(conversationId) ?? [])];
  }

  async findTaskByCommandId(conversationId: ConversationId, commandId: string): Promise<WorkflowTask | null> {
    const found = (this.tasks.get(conversationId) ?? []).find((task) => task.commandId === commandId);
    if (!found) return null;
    const { commandId: _commandId, ...task } = found;
    return task;
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const bucket = this.tasks.get(input.conversationId) ?? [];
    const duplicate = bucket.find((task) => task.commandId === input.commandId);
    if (duplicate) {
      const { commandId: _commandId, ...task } = duplicate;
      return { ok: false, reason: 'duplicate_command', task };
    }
    const active = bucket.some(
      (task) => task.agentId === input.agentId && (task.status === 'pending' || task.status === 'in_progress'),
    );
    if (active) return { ok: false, reason: 'active_task_exists' };
    const id = this.newTaskId();
    const task: WorkflowTask & { readonly commandId: string } = {
      id,
      agentId: input.agentId,
      status: 'pending',
      errorCategory: null,
      parentTaskId: input.iteration?.parentTaskId ?? null,
      iterationRootId: input.iteration?.iterationRootId ?? id,
      iterationNumber: input.iteration?.iterationNumber ?? 1,
      iterationTrigger: input.iteration?.trigger ?? null,
      createdAt: this.nextTimestamp(),
      upstreamApprovals: recordedUpstream(input.requirementsSnapshot),
      commandId: input.commandId,
    };
    bucket.push(task);
    this.tasks.set(input.conversationId, bucket);
    this.requirements.set(id, { ...input.requirementsSnapshot });
    const { commandId: _commandId, ...view } = task;
    return { ok: true, task: view };
  }

  async cancelPendingTask(conversationId: ConversationId, taskId: TaskId): Promise<boolean> {
    return this.transition(conversationId, taskId, ['pending'], { status: 'canceled' });
  }

  /** Test/worker hook: mark a pending task as claimed (`pending -> in_progress`). */
  async markInProgress(conversationId: ConversationId, taskId: TaskId): Promise<boolean> {
    return this.transition(conversationId, taskId, ['pending'], { status: 'in_progress' });
  }

  async recordSettlement(input: RecordSettlementInput): Promise<RecordSettlementResult> {
    const settled = this.transition(input.conversationId, input.taskId, ['pending', 'in_progress'], {
      status: input.status,
      errorCategory: input.status === 'failed' ? input.errorCategory ?? 'permanent_bug' : null,
      errorKind: input.status === 'failed' ? input.error?.kind ?? null : null,
    });
    if (!settled) return { applied: false, deliverableIds: [] };
    if (input.status !== 'completed') return { applied: true, deliverableIds: [] };
    const ids: DeliverableId[] = [];
    const bucket = this.candidates.get(input.conversationId) ?? [];
    input.artifacts.forEach((artifact, index) => {
      const deliverableId = (input.deliverableIds[index] ?? randomUUID()) as DeliverableId;
      ids.push(deliverableId);
      bucket.push({
        deliverableId,
        agentTaskId: input.taskId,
        kind: input.deliverableKind,
        contentUrl: artifact.url ?? null,
        // Same shape as the Postgres settlement (`settleTaskAndEnqueue`).
        contentInline: artifact.url ? null : { value: artifact.inline ?? null, kind: artifact.kind, metadata: artifact.metadata ?? {} },
        createdAt: this.nextTimestamp(),
        inputVersions: recordedFieldVersions(artifact.metadata),
      });
    });
    this.candidates.set(input.conversationId, bucket);
    return { applied: true, deliverableIds: ids };
  }

  /** Test hook: the requirements snapshot persisted with a task. */
  requirementsOf(taskId: TaskId): Record<string, unknown> | null {
    return this.requirements.get(taskId) ?? null;
  }

  private transition(
    conversationId: ConversationId,
    taskId: TaskId,
    from: ReadonlyArray<WorkflowTaskStatus>,
    patch: Partial<Pick<WorkflowTask, 'status' | 'errorCategory' | 'errorKind'>>,
  ): boolean {
    const bucket = this.tasks.get(conversationId) ?? [];
    const index = bucket.findIndex((task) => task.id === taskId);
    if (index < 0 || !from.includes(bucket[index].status)) return false;
    bucket[index] = { ...bucket[index], ...patch };
    return true;
  }

  /** Strictly increasing ISO timestamps so creation order is deterministic. */
  private nextTimestamp(): ISOTimestamp {
    const next = Math.max(this.now().getTime(), this.clock + 1);
    this.clock = next;
    return new Date(next).toISOString();
  }
}
