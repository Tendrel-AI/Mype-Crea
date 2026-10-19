/**
 * agent_tasks repository.
 *
 * Per docs/agents/database.md:
 *   - agent_tasks RLS is tenant-only (no user axis); we still enforce ownership
 *     through conversation join at the application layer when relevant.
 *   - JSONB invariant: every UUID embedded in requirements_snapshot or error
 *     must belong to the current tenant. Enforced by `assertJsonbTenantSafe`
 *     which uses RLS to detect foreign/unknown UUIDs.
 *   - claimNextPending uses the single-statement CTE form mandated by the skill;
 *     never split into SELECT FOR UPDATE + UPDATE.
 *   - For root tasks, iteration_root_id = id (app-enforced invariant; no CHECK).
 */
import { randomUUID } from 'node:crypto';
import type { ConversationId, TaskId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type TxClient } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import type {
  AgentTaskIterationInsert,
  AgentTaskRootInsert,
  AgentTaskRow,
  AgentTaskStatus,
  ErrorCategory,
  IterationTrigger,
} from './models';

const log = loggerFor('repo.agent_tasks');

const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

interface AgentTaskRowDb {
  id: UUID;
  conversation_id: UUID;
  agent_id: string;
  agent_card_version: string;
  status: AgentTaskStatus;
  attempts: number;
  idempotency_key: UUID;
  parent_task_id: UUID | null;
  iteration_root_id: UUID;
  iteration_number: number;
  iteration_trigger: IterationTrigger | null;
  requirements_snapshot: Record<string, unknown>;
  error: Record<string, unknown> | null;
  error_category: ErrorCategory | null;
  scheduled_for: Date;
  dispatched_at: Date | null;
  completed_at: Date | null;
  last_attempt_at: Date | null;
  created_at: Date;
}

function toDomain(row: AgentTaskRowDb): AgentTaskRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    agentCardVersion: row.agent_card_version,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    parentTaskId: row.parent_task_id,
    iterationRootId: row.iteration_root_id,
    iterationNumber: row.iteration_number,
    iterationTrigger: row.iteration_trigger,
    requirementsSnapshot: row.requirements_snapshot,
    error: row.error,
    errorCategory: row.error_category,
    scheduledFor: row.scheduled_for.toISOString(),
    dispatchedAt: row.dispatched_at ? row.dispatched_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Recursively pull every UUID-shaped string out of a JSONB-bound value.
 */
function extractUuids(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (value === null || value === undefined) return acc;
  if (typeof value === 'string') {
    const matches = value.match(UUID_REGEX);
    if (matches) for (const m of matches) acc.add(m.toLowerCase());
    return acc;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractUuids(v, acc);
    return acc;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      extractUuids(v, acc);
    }
  }
  return acc;
}

/**
 * Verify every UUID embedded in a JSONB payload is reachable under the current
 * tenant's RLS context. If any UUID is invisible (foreign tenant or unknown),
 * the insert is rejected. This is the JSONB invariant from the database skill.
 *
 * Caller MUST already be inside a tx that has set app.tenant_id.
 */
async function assertJsonbTenantSafe(tx: TxClient, payload: unknown): Promise<void> {
  const uuids = extractUuids(payload);
  if (uuids.size === 0) return;
  const list = [...uuids];
  const res = await tx.query<{ id: UUID }>(
    `SELECT id FROM (
       SELECT id FROM conversations
       UNION ALL SELECT id FROM agent_tasks
       UNION ALL SELECT id FROM deliverables
       UNION ALL SELECT id FROM users
     ) AS visible
     WHERE id = ANY($1::uuid[])`,
    [list],
  );
  const visible = new Set(res.rows.map((r) => r.id.toLowerCase()));
  const foreign = list.filter((u) => !visible.has(u));
  if (foreign.length > 0) {
    throw new Error(
      `JSONB tenant safety: UUIDs not visible under current tenant: ${foreign.join(', ')}`,
    );
  }
}

export function agentTasksRepo(tenant: Tenant) {
  return {
    /** Tenant-only recovery scan for tasks committed before queue publication. */
    async listPendingDispatches(input: { agentId?: string; limit?: number } = {}): Promise<AgentTaskRow[]> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const result = await tx.query<AgentTaskRowDb>(
          `SELECT * FROM agent_tasks
            WHERE tenant_id=$1 AND status='pending' AND scheduled_for <= now()
              AND ($2::text IS NULL OR agent_id=$2)
            ORDER BY scheduled_for,id LIMIT $3`,
          [tenant.id,input.agentId??null,Math.min(Math.max(input.limit??100,1),500)],
        );
        return result.rows.map(toDomain);
      });
    },
    /**
     * Insert a root task (iteration_number=1, parent_task_id=NULL,
     * iteration_root_id=id). The id is generated app-side so the same value
     * can be used for both columns in a single statement.
     */
    async insertRoot(input: AgentTaskRootInsert): Promise<AgentTaskRow> {
      const child = log.child({
        op: 'insertRoot',
        tenantId: tenant.id,
        conversationId: input.conversationId,
        agentId: input.agentId,
      });
      const id = randomUUID();
      child.debug({ id, idempotencyKey: input.idempotencyKey }, 'inserting root agent_task');
      return withTenantTransaction(tenant, undefined, async (tx) => {
        await assertJsonbTenantSafe(tx, input.requirementsSnapshot);
        const res = await tx.query<AgentTaskRowDb>(
          `INSERT INTO agent_tasks
             (id, tenant_id, conversation_id, agent_id, agent_card_version,
              idempotency_key, iteration_root_id, iteration_number,
              parent_task_id, iteration_trigger,
              requirements_snapshot, scheduled_for)
           VALUES ($1, $2, $3, $4, $5,
                   $6, $1, 1,
                   NULL, NULL,
                   $7::jsonb, COALESCE($8::timestamptz, now()))
           RETURNING *`,
          [
            id,
            tenant.id,
            input.conversationId,
            input.agentId,
            input.agentCardVersion,
            input.idempotencyKey,
            JSON.stringify(input.requirementsSnapshot),
            input.scheduledFor ?? null,
          ],
        );
        const row = toDomain(res.rows[0]);
        child.info({ id: row.id }, 'root agent_task inserted');
        return row;
      });
    },

    /**
     * Insert an iteration of an existing task. Caller supplies the parent
     * and iteration_root references; iteration_number is explicit so the
     * caller controls collision behavior under retries.
     */
    async insertIteration(input: AgentTaskIterationInsert): Promise<AgentTaskRow> {
      const child = log.child({
        op: 'insertIteration',
        tenantId: tenant.id,
        conversationId: input.conversationId,
        agentId: input.agentId,
        parentTaskId: input.parentTaskId,
      });
      child.debug(
        { iterationRootId: input.iterationRootId, iterationNumber: input.iterationNumber },
        'inserting iteration agent_task',
      );
      return withTenantTransaction(tenant, undefined, async (tx) => {
        await assertJsonbTenantSafe(tx, input.requirementsSnapshot);
        const res = await tx.query<AgentTaskRowDb>(
          `INSERT INTO agent_tasks
             (tenant_id, conversation_id, agent_id, agent_card_version,
              idempotency_key, iteration_root_id, iteration_number,
              parent_task_id, iteration_trigger,
              requirements_snapshot, scheduled_for)
           VALUES ($1, $2, $3, $4,
                   $5, $6, $7,
                   $8, $9,
                   $10::jsonb, COALESCE($11::timestamptz, now()))
           RETURNING *`,
          [
            tenant.id,
            input.conversationId,
            input.agentId,
            input.agentCardVersion,
            input.idempotencyKey,
            input.iterationRootId,
            input.iterationNumber,
            input.parentTaskId,
            input.iterationTrigger,
            JSON.stringify(input.requirementsSnapshot),
            input.scheduledFor ?? null,
          ],
        );
        const row = toDomain(res.rows[0]);
        child.info({ id: row.id }, 'iteration agent_task inserted');
        return row;
      });
    },

    /**
     * Atomically claim the next pending task scheduled for now-or-earlier.
     * MUST stay as a single CTE statement (database skill §Claim pattern):
     * the two-statement form is racy even with SKIP LOCKED.
     */
    async claimNextPending(): Promise<AgentTaskRow | null> {
      const child = log.child({ op: 'claimNextPending', tenantId: tenant.id });
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query<AgentTaskRowDb>(
          `UPDATE agent_tasks
              SET status         = 'in_progress',
                  last_attempt_at = now(),
                  attempts        = attempts + 1,
                  dispatched_at   = COALESCE(dispatched_at, now())
            WHERE id = (
              SELECT id FROM agent_tasks
               WHERE tenant_id    = app.current_tenant_id()
                 AND status       = 'pending'
                 AND scheduled_for <= now()
               ORDER BY scheduled_for
               FOR UPDATE SKIP LOCKED
               LIMIT 1
            )
            RETURNING *`,
        );
        if (res.rows.length === 0) {
          child.debug('no pending task');
          return null;
        }
        const row = toDomain(res.rows[0]);
        child.info({ id: row.id, agentId: row.agentId }, 'claimed pending task');
        return row;
      });
    },

    /**
     * Claim a specific pending task by id. Implements the per-architecture
     * §2.5 claim semantics: `UPDATE ... SET status='in_progress' WHERE
     * status='pending' AND id=$1 RETURNING *`. Returns null if the task is
     * already in_progress, completed, failed, or doesn't exist under this
     * tenant — never throws on contention. Used by the Redis-pub/sub-driven
     * agent worker after it receives a wake-up notification.
     */
    async claimById(id: TaskId): Promise<AgentTaskRow | null> {
      const child = log.child({ op: 'claimById', tenantId: tenant.id, taskId: id });
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query<AgentTaskRowDb>(
          `UPDATE agent_tasks
              SET status         = 'in_progress',
                  last_attempt_at = now(),
                  attempts        = attempts + 1,
                  dispatched_at   = COALESCE(dispatched_at, now())
            WHERE id     = $1
              AND status = 'pending'
            RETURNING *`,
          [id],
        );
        if (res.rows.length === 0) {
          child.debug('task not claimable (missing or not pending)');
          return null;
        }
        const row = toDomain(res.rows[0]);
        child.info({ agentId: row.agentId }, 'claimed task by id');
        return row;
      });
    },

    async findById(id: TaskId): Promise<AgentTaskRow | null> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query<AgentTaskRowDb>(
          `SELECT * FROM agent_tasks WHERE id = $1 LIMIT 1`,
          [id],
        );
        return res.rows.length ? toDomain(res.rows[0]) : null;
      });
    },

    async listByConversation(conversationId: ConversationId): Promise<AgentTaskRow[]> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query<AgentTaskRowDb>(
          `SELECT * FROM agent_tasks
            WHERE conversation_id = $1
            ORDER BY created_at ASC`,
          [conversationId],
        );
        return res.rows.map(toDomain);
      });
    },

    async markCompleted(id: TaskId): Promise<void> {
      const child = log.child({ op: 'markCompleted', tenantId: tenant.id, taskId: id });
      await withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query(
          `UPDATE agent_tasks
              SET status       = 'completed',
                  completed_at = now()
            WHERE id = $1`,
          [id],
        );
        child.info({ rowsAffected: res.rowCount }, 'agent_task completed');
        if (res.rowCount === 0) {
          throw new Error(`No agent_task row to mark completed: ${id}`);
        }
      });
    },

    async markFailed(
      id: TaskId,
      error: Record<string, unknown>,
      errorCategory: ErrorCategory,
    ): Promise<void> {
      const child = log.child({
        op: 'markFailed',
        tenantId: tenant.id,
        taskId: id,
        errorCategory,
      });
      await withTenantTransaction(tenant, undefined, async (tx) => {
        await assertJsonbTenantSafe(tx, error);
        const res = await tx.query(
          `UPDATE agent_tasks
              SET status         = 'failed',
                  completed_at   = now(),
                  error          = $2::jsonb,
                  error_category = $3
            WHERE id = $1`,
          [id, JSON.stringify(error), errorCategory],
        );
        child.warn({ rowsAffected: res.rowCount }, 'agent_task failed');
        if (res.rowCount === 0) {
          throw new Error(`No agent_task row to mark failed: ${id}`);
        }
      });
    },
  };
}

export type AgentTasksRepo = ReturnType<typeof agentTasksRepo>;

// Exposed for unit testing.
export const __test = { extractUuids };
