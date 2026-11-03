/**
 * MYPES Platform — Postgres deliverable workflow store (KAN-28)
 * ==============================================================
 *
 * `IDeliverableWorkflowStore` over the tenant-scoped repositories:
 *   - tasks       -> `systemRepos(tenant).agentTasks` (agent_tasks RLS is
 *                    tenant-only; the core reaches this store only for a
 *                    conversation whose owner `startConversation` authorized)
 *   - candidates  -> `repos(tenant, user).deliverables` (tenant + owner RLS)
 *
 * Iterar / Reintentar rows go through the repository's guarded iteration
 * insert (shared with KAN-34 `refinements.createIteration`): ownership via
 * the conversation, parent status, anchor in parent, and the iteration
 * number computed under a root lock. The core's `iterationNumber` /
 * `iterationRootId` are therefore not sent; the returned row is authoritative.
 *
 * Deliverables are written by the agent workers (`aiTurns.settleTaskAndEnqueue`),
 * never here: `recordSettlement` only settles the task row for the
 * non-durable LocalAdapter path, and only while it is still active, so a
 * result that arrives after Cancelar never overwrites `canceled`.
 */

import type { ConversationId, DeliverableId, TaskId, UUID } from '../contracts';
import { repos, systemRepos, type Tenant, type User } from '../../repos';
import type { AgentTaskRow, DeliverableRow } from '../../repos/models';
import { clientDeliverableUrl } from '../deliverable-url';
import type {
  CreateTaskInput,
  CreateTaskResult,
  IDeliverableWorkflowStore,
  RecordSettlementInput,
  RecordSettlementResult,
  WorkflowCandidate,
  WorkflowTask,
} from './deliverable-workflow';

function toWorkflowTask(row: AgentTaskRow): WorkflowTask {
  return {
    id: row.id as TaskId,
    agentId: row.agentId,
    status: row.status,
    errorCategory: row.errorCategory,
    errorKind: typeof row.error?.kind === 'string' ? row.error.kind : null,
    parentTaskId: (row.parentTaskId ?? null) as TaskId | null,
    iterationRootId: row.iterationRootId as TaskId,
    iterationNumber: row.iterationNumber,
    iterationTrigger: row.iterationTrigger,
    createdAt: row.createdAt,
  };
}

function toCandidate(row: DeliverableRow): WorkflowCandidate {
  return {
    deliverableId: row.id as DeliverableId,
    agentTaskId: row.agentTaskId as TaskId,
    kind: row.kind,
    // Views reach the browser: a stored image is only ever `/api/assets/<id>` (KAN-52).
    contentUrl: clientDeliverableUrl(row),
    contentInline: row.contentInline,
    createdAt: row.createdAt,
  };
}

export class PostgresDeliverableWorkflowStore implements IDeliverableWorkflowStore {
  private readonly tenant: Tenant;
  private readonly user: User;

  constructor(tenantId: UUID, userId: UUID) {
    this.tenant = { id: tenantId };
    this.user = { id: userId };
  }

  private get tasks() {
    return systemRepos(this.tenant).agentTasks;
  }

  async listTasks(conversationId: ConversationId): Promise<ReadonlyArray<WorkflowTask>> {
    return (await this.tasks.listByConversation(conversationId)).map(toWorkflowTask);
  }

  async listCandidates(conversationId: ConversationId): Promise<ReadonlyArray<WorkflowCandidate>> {
    const rows = await repos(this.tenant, this.user).deliverables.listByConversation(conversationId);
    return rows.map(toCandidate);
  }

  async findTaskByCommandId(conversationId: ConversationId, commandId: string): Promise<WorkflowTask | null> {
    const row = await this.tasks.findByIdempotencyKey(conversationId, commandId as UUID);
    return row ? toWorkflowTask(row) : null;
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const result = await this.tasks.insertCommandTask({
      conversationId: input.conversationId,
      agentId: input.agentId,
      agentCardVersion: input.agentCardVersion,
      idempotencyKey: input.commandId as UUID,
      requirementsSnapshot: input.requirementsSnapshot,
      owner: this.user,
      // The repository derives the root and the number from the parent under a lock.
      iteration: input.iteration
        ? { parentTaskId: input.iteration.parentTaskId, trigger: input.iteration.trigger }
        : undefined,
    });
    if (result.ok) return { ok: true, task: toWorkflowTask(result.row) };
    if (result.reason === 'duplicate_command') {
      return { ok: false, reason: 'duplicate_command', task: toWorkflowTask(result.row) };
    }
    if (result.reason === 'invalid_parent') return { ok: false, reason: 'parent_unavailable' };
    return { ok: false, reason: 'active_task_exists' };
  }

  async cancelPendingTask(conversationId: ConversationId, taskId: TaskId): Promise<boolean> {
    return this.tasks.cancelPending(conversationId, taskId);
  }

  async recordSettlement(input: RecordSettlementInput): Promise<RecordSettlementResult> {
    const applied = await this.tasks.settleIfActive(
      input.taskId,
      input.status === 'completed'
        ? { status: 'completed' }
        : {
            status: 'failed',
            error: { kind: input.error?.kind ?? 'unknown', message: input.error?.message ?? '' },
            errorCategory: input.errorCategory ?? 'permanent_bug',
          },
    );
    return { applied, deliverableIds: input.deliverableIds };
  }
}
