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
import { withTenantTransaction, type Tenant, type TxClient, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import {
  REFINEMENT_SNAPSHOT_KEY,
  RefinementValidationError,
  checkStoredRefinement,
  type IterationRefinement,
} from './refinement-rules';
import type {
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

/**
 * Why a guarded iteration insert refused its parent (KAN-28 / KAN-34). Every
 * refusal happens before any write.
 */
export type IterationTargetRejection =
  /** Parent missing, of another conversation/agent, or its conversation is not visible to the bound owner. */
  | 'parent_not_found'
  /** Iterar (user trigger) needs a completed parent: a candidate to refine. */
  | 'parent_not_completed'
  /** Reintentar (`failure` trigger) needs a failed parent. */
  | 'parent_not_failed'
  /** The refinement's anchor is not a deliverable of the parent task. */
  | 'anchor_not_in_parent';

interface GuardedIterationInsert {
  readonly parentTaskId: TaskId;
  /** When set, the parent must belong to this conversation and agent. */
  readonly conversationId?: ConversationId;
  readonly agentId?: string;
  readonly trigger: IterationTrigger;
  readonly idempotencyKey: UUID;
  /** Defaults to the parent task's card version. */
  readonly agentCardVersion?: string;
  /** Requirements to store; `'parent'` copies the parent's snapshot. A `refinement` key in it is always dropped. */
  readonly baseRequirements: Readonly<Record<string, unknown>> | 'parent';
  /** Already validated by the caller with the single rule; the DB CHECK is the backstop. */
  readonly refinement: IterationRefinement | null;
  readonly scheduledFor?: string;
}

type GuardedIterationResult =
  | { readonly ok: true; readonly row: AgentTaskRow }
  | { readonly ok: false; readonly reason: IterationTargetRejection };

/**
 * THE iteration insert (KAN-28 Iterar/Reintentar commands and KAN-34
 * `refinements.createIteration` both go through it). Inside the caller's
 * transaction, which must bind the conversation owner (`app.user_id`):
 *   1. the parent exists in this tenant (and, when given, in this
 *      conversation and agent);
 *   2. ownership through the conversation: its row must be visible under the
 *      owner's RLS and is locked `FOR UPDATE`, never updated (the brief stays
 *      untouched);
 *   3. the parent is `failed` for a `failure` retry, `completed` otherwise;
 *   4. a refinement anchor must be a deliverable of the parent task;
 *   5. the iteration number is max+1 of the chain, computed under a lock on
 *      the root task, so concurrent iterations get distinct numbers;
 *   6. the parent's `refinement` key never carries forward; the new one (if
 *      any) is stored under the reserved key, and the CHECK
 *      `agent_tasks_refinement_valid` applies the same rule as a backstop.
 */
async function insertGuardedIteration(
  tx: TxClient,
  tenant: Tenant,
  input: GuardedIterationInsert,
): Promise<GuardedIterationResult> {
  const refuse = (reason: IterationTargetRejection) => ({ ok: false, reason }) as const;
  const parentRes = await tx.query<AgentTaskRowDb>(
    `SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, input.parentTaskId],
  );
  const parent = parentRes.rows[0];
  if (!parent) return refuse('parent_not_found');
  if (input.conversationId !== undefined && parent.conversation_id !== input.conversationId.toLowerCase()) {
    return refuse('parent_not_found');
  }
  if (input.agentId !== undefined && parent.agent_id !== input.agentId) return refuse('parent_not_found');

  const conv = await tx.query(
    `SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenant.id, parent.conversation_id],
  );
  if (conv.rowCount === 0) return refuse('parent_not_found');

  if (input.trigger === 'failure') {
    if (parent.status !== 'failed') return refuse('parent_not_failed');
  } else if (parent.status !== 'completed') {
    return refuse('parent_not_completed');
  }

  const anchorId = input.refinement?.anchorDeliverableId ?? null;
  if (anchorId !== null) {
    const anchor = await tx.query(
      `SELECT 1 FROM deliverables WHERE tenant_id = $1 AND id = $2 AND agent_task_id = $3`,
      [tenant.id, anchorId, parent.id],
    );
    if (anchor.rowCount === 0) return refuse('anchor_not_in_parent');
  }

  await tx.query(`SELECT 1 FROM agent_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
    tenant.id,
    parent.iteration_root_id,
  ]);
  const next = await tx.query<{ n: number }>(
    `SELECT coalesce(max(iteration_number), 0)::int + 1 AS n
       FROM agent_tasks WHERE tenant_id = $1 AND iteration_root_id = $2`,
    [tenant.id, parent.iteration_root_id],
  );
  const iterationNumber = Math.max(next.rows[0].n, 2);

  const base: Record<string, unknown> = {
    ...(input.baseRequirements === 'parent' ? parent.requirements_snapshot : input.baseRequirements),
  };
  delete base[REFINEMENT_SNAPSHOT_KEY];
  const snapshot = input.refinement ? { ...base, [REFINEMENT_SNAPSHOT_KEY]: input.refinement } : base;
  await assertJsonbTenantSafe(tx, snapshot);

  const res = await tx.query<AgentTaskRowDb>(
    `INSERT INTO agent_tasks
       (tenant_id, conversation_id, agent_id, agent_card_version,
        idempotency_key, iteration_root_id, iteration_number,
        parent_task_id, iteration_trigger,
        requirements_snapshot, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             COALESCE($11::timestamptz, now()))
     RETURNING *`,
    [
      tenant.id,
      parent.conversation_id,
      parent.agent_id,
      input.agentCardVersion ?? parent.agent_card_version,
      input.idempotencyKey,
      parent.iteration_root_id,
      iterationNumber,
      parent.id,
      input.trigger,
      JSON.stringify(snapshot),
      input.scheduledFor ?? null,
    ],
  );
  return { ok: true, row: toDomain(res.rows[0]) };
}

/** Input of `insertCommandTask` (KAN-28 typed deliverable commands). */
export interface AgentTaskCommandInsert {
  readonly conversationId: ConversationId;
  readonly agentId: string;
  readonly agentCardVersion: string;
  /** The command id; doubles as the task's idempotency key. */
  readonly idempotencyKey: UUID;
  readonly requirementsSnapshot: Record<string, unknown>;
  /**
   * The conversation owner. Binds `app.user_id` for the insert transaction so
   * the JSONB tenant-safety check can see owner-scoped rows referenced by the
   * snapshot (the refinement's `anchorDeliverableId` is a deliverable, whose
   * RLS is tenant + owner) and the iteration guard can check ownership
   * through the conversation. Required for iterations (without it the parent
   * is reported `parent_not_found`). agent_tasks itself stays tenant-scoped.
   */
  readonly owner?: User;
  /**
   * Present for Iterar / Reintentar; absent for a root Generar. The root and
   * the iteration number are derived from the parent under a lock (see
   * `insertGuardedIteration`), never taken from the caller.
   */
  readonly iteration?: {
    readonly parentTaskId: TaskId;
    readonly trigger: IterationTrigger;
  };
}

export type AgentTaskCommandInsertResult =
  | { readonly ok: true; readonly row: AgentTaskRow }
  | { readonly ok: false; readonly reason: 'active_task_exists' }
  | { readonly ok: false; readonly reason: 'duplicate_command'; readonly row: AgentTaskRow }
  /** The iteration's parent (or anchor) is not usable; see `IterationTargetRejection`. */
  | { readonly ok: false; readonly reason: 'invalid_parent'; readonly detail: IterationTargetRejection };

const UNIQUE_VIOLATION = '23505';

export function agentTasksRepo(tenant: Tenant) {
  return {
    /** The task a command id created, if any (idempotent replay of a command). */
    async findByIdempotencyKey(conversationId: ConversationId, idempotencyKey: UUID): Promise<AgentTaskRow | null> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query<AgentTaskRowDb>(
          `SELECT * FROM agent_tasks
            WHERE tenant_id = $1 AND idempotency_key = $2 AND conversation_id = $3
            LIMIT 1`,
          [tenant.id, idempotencyKey, conversationId],
        );
        return res.rows.length ? toDomain(res.rows[0]) : null;
      });
    },

    /**
     * Guarded insert for a typed deliverable command (KAN-28). In ONE
     * transaction, serialized per conversation with a transaction-scoped
     * advisory lock:
     *   1. the same idempotency key already exists -> `duplicate_command`;
     *   2. another task of the same (conversation, agent) is pending or in
     *      progress -> `active_task_exists` (no double generation, even when
     *      two commands raced past validation);
     *   3. otherwise insert the root task, or the iteration through the
     *      shared guarded insert (`insertGuardedIteration`: ownership, parent
     *      status, anchor in parent, numbering under the root lock), which
     *      refuses with `invalid_parent`.
     * A refinement in an iteration snapshot is checked with the single rule
     * (`RefinementValidationError` on failure; the core validates first, so
     * this is a backstop like the DB CHECK). A unique violation on the
     * idempotency key from a path outside the lock is reported as
     * `duplicate_command` too.
     */
    async insertCommandTask(input: AgentTaskCommandInsert): Promise<AgentTaskCommandInsertResult> {
      const child = log.child({
        op: 'insertCommandTask',
        tenantId: tenant.id,
        conversationId: input.conversationId,
        agentId: input.agentId,
      });
      const findDuplicate = async (tx: TxClient) => {
        const res = await tx.query<AgentTaskRowDb>(
          `SELECT * FROM agent_tasks WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [tenant.id, input.idempotencyKey],
        );
        return res.rows.length ? toDomain(res.rows[0]) : null;
      };
      try {
        return await withTenantTransaction(tenant, input.owner, async (tx) => {
          await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('agent_tasks.command:' || $1::text, 0))`, [
            input.conversationId,
          ]);
          const duplicate = await findDuplicate(tx);
          if (duplicate) return { ok: false, reason: 'duplicate_command', row: duplicate } as const;
          const active = await tx.query(
            `SELECT 1 FROM agent_tasks
              WHERE conversation_id = $1 AND agent_id = $2 AND status IN ('pending', 'in_progress')
              LIMIT 1`,
            [input.conversationId, input.agentId],
          );
          if (active.rows.length > 0) return { ok: false, reason: 'active_task_exists' } as const;

          if (input.iteration) {
            const { [REFINEMENT_SNAPSHOT_KEY]: rawRefinement, ...requirements } = input.requirementsSnapshot;
            let refinement: IterationRefinement | null = null;
            if (rawRefinement !== undefined) {
              const checked = checkStoredRefinement(rawRefinement);
              if (!checked.ok) throw new RefinementValidationError(checked.code, checked.message);
              refinement = checked.value;
            }
            const inserted = await insertGuardedIteration(tx, tenant, {
              parentTaskId: input.iteration.parentTaskId,
              conversationId: input.conversationId,
              agentId: input.agentId,
              trigger: input.iteration.trigger,
              idempotencyKey: input.idempotencyKey,
              agentCardVersion: input.agentCardVersion,
              baseRequirements: requirements,
              refinement,
            });
            if (!inserted.ok) {
              child.info({ reason: inserted.reason }, 'command iteration refused');
              return { ok: false, reason: 'invalid_parent', detail: inserted.reason } as const;
            }
            child.info(
              { id: inserted.row.id, iterationNumber: inserted.row.iterationNumber, iterationTrigger: inserted.row.iterationTrigger },
              'command agent_task inserted',
            );
            return { ok: true, row: inserted.row } as const;
          }

          await assertJsonbTenantSafe(tx, input.requirementsSnapshot);
          const id = randomUUID();
          const res = await tx.query<AgentTaskRowDb>(
            `INSERT INTO agent_tasks
               (id, tenant_id, conversation_id, agent_id, agent_card_version,
                idempotency_key, iteration_root_id, iteration_number,
                parent_task_id, iteration_trigger, requirements_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $1, 1, NULL, NULL, $7::jsonb)
             RETURNING *`,
            [
              id,
              tenant.id,
              input.conversationId,
              input.agentId,
              input.agentCardVersion,
              input.idempotencyKey,
              JSON.stringify(input.requirementsSnapshot),
            ],
          );
          const row = toDomain(res.rows[0]);
          child.info(
            { id: row.id, iterationNumber: row.iterationNumber, iterationTrigger: row.iterationTrigger },
            'command agent_task inserted',
          );
          return { ok: true, row } as const;
        });
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
        const row = await withTenantTransaction(tenant, undefined, findDuplicate);
        if (!row) throw err;
        return { ok: false, reason: 'duplicate_command', row };
      }
    },

    /** `pending -> canceled` only (Cancelar, KAN-64). False when already claimed or gone. */
    async cancelPending(conversationId: ConversationId, id: TaskId): Promise<boolean> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        const res = await tx.query(
          `UPDATE agent_tasks
              SET status = 'canceled', completed_at = now()
            WHERE id = $1 AND conversation_id = $2 AND status = 'pending'`,
          [id, conversationId],
        );
        const canceled = (res.rowCount ?? 0) > 0;
        log.info({ op: 'cancelPending', tenantId: tenant.id, taskId: id, canceled }, 'agent_task cancel attempted');
        return canceled;
      });
    },

    /**
     * Settle a task only while it is still pending / in progress, so a
     * result that arrives after Cancelar never overwrites `canceled`.
     * Returns false when nothing was updated.
     */
    async settleIfActive(
      id: TaskId,
      outcome:
        | { readonly status: 'completed' }
        | { readonly status: 'failed'; readonly error: Record<string, unknown>; readonly errorCategory: ErrorCategory },
    ): Promise<boolean> {
      return withTenantTransaction(tenant, undefined, async (tx) => {
        if (outcome.status === 'failed') await assertJsonbTenantSafe(tx, outcome.error);
        const res = await tx.query(
          `UPDATE agent_tasks
              SET status         = $2::task_status,
                  completed_at   = now(),
                  error          = $3::jsonb,
                  error_category = $4
            WHERE id = $1 AND status IN ('pending', 'in_progress')`,
          [
            id,
            outcome.status,
            outcome.status === 'failed' ? JSON.stringify(outcome.error) : null,
            outcome.status === 'failed' ? outcome.errorCategory : null,
          ],
        );
        return (res.rowCount ?? 0) > 0;
      });
    },

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
      return withTenantTransaction(tenant, input.owner, async (tx) => {
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
     *
     * `agentId`, when given, makes the claim conditional on the row's agent:
     * a task addressed to another agent is left `pending` (returns null).
     */
    async claimById(id: TaskId, agentId?: string): Promise<AgentTaskRow | null> {
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
              AND ($2::text IS NULL OR agent_id = $2::text)
            RETURNING *`,
          [id, agentId ?? null],
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

// Shared with repositories that write agent_tasks rows in their own transaction
// (src/repos/refinements.ts).
export {
  assertJsonbTenantSafe,
  insertGuardedIteration,
  toDomain as agentTaskRowToDomain,
  type AgentTaskRowDb,
  type GuardedIterationInsert,
  type GuardedIterationResult,
};
