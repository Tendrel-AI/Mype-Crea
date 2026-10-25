/**
 * Iteration refinement repository (KAN-34 / RF-06, decision KAN-65 R2).
 *
 * Creates an iteration `agent_tasks` row whose `requirements_snapshot` carries the validated,
 * iteration-local refinement under the reserved key `refinement`:
 *   `{ parameterChanges, observations[], anchorDeliverableId }` (caps in src/core/refinement.ts, the single rule).
 *
 * Guarantees:
 *   - Refinement never writes the brief: `conversations.agent_states` is only locked, never
 *     updated. Panel overrides live in this one iteration; the parent's `refinement` key is
 *     dropped from the copied snapshot so overrides do not carry forward.
 *   - `agent_tasks` RLS is tenant-only, so ownership is checked through the conversation: the
 *     parent task's conversation must be visible to (owned by) the current user, and it is
 *     locked `FOR UPDATE` like every other conversation-scoped command.
 *   - The parent task must be `completed` (a candidate exists), and the anchor, when present,
 *     must be a deliverable of the parent task.
 *   - The iteration number is computed under a lock on the root task, so concurrent
 *     iterations of the same chain get distinct numbers.
 *   - The database CHECK `agent_tasks_refinement_valid` applies the same rule as a backstop.
 *
 * This module only persists the row (status `pending`). Dispatching it through
 * `IAgentTransport` is the caller's job (KAN-28 command handler).
 */
import type { TaskId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { agentTaskRowToDomain, assertJsonbTenantSafe, type AgentTaskRowDb } from './agent-tasks';
import { isUuid } from './approvals';
import type { AgentTaskRow, IterationTrigger } from './models';
import {
  REFINEMENT_SNAPSHOT_KEY,
  RefinementValidationError,
  validateRefinement,
  type IterationRefinement,
  type IterationRefinementInput,
} from './refinement-rules';

const log = loggerFor('repo.refinements');

export interface RefinementIterationInput {
  readonly parentTaskId: TaskId;
  readonly idempotencyKey: UUID;
  /** Refinement iterations are user commands; `failure` retries do not carry a refinement. */
  readonly iterationTrigger: Exclude<IterationTrigger, 'failure'>;
  readonly refinement: IterationRefinementInput;
  /** Defaults to the parent task's card version. */
  readonly agentCardVersion?: string;
  readonly scheduledFor?: string;
}

export class RefinementTargetError extends Error {
  constructor(
    readonly reason: 'parent_not_found' | 'parent_not_completed' | 'anchor_not_in_parent',
  ) {
    super(`refinements.createIteration: ${reason}`);
    this.name = 'RefinementTargetError';
  }
}

export function refinementsRepo(tenant: Tenant, user: User) {
  return {
    /**
     * Validate the refinement and insert the iteration row. Throws
     * `RefinementValidationError` (user-visible Spanish `message`) when the payload breaks the
     * caps, and `RefinementTargetError` when the parent or anchor is not usable by this user.
     */
    async createIteration(input: RefinementIterationInput): Promise<AgentTaskRow> {
      const checked = validateRefinement(input.refinement);
      if (!checked.ok) throw new RefinementValidationError(checked.code, checked.message);
      const refinement: IterationRefinement = checked.value;
      if (!isUuid(input.parentTaskId)) throw new RefinementTargetError('parent_not_found');

      const child = log.child({
        op: 'createIteration',
        tenantId: tenant.id,
        userId: user.id,
        parentTaskId: input.parentTaskId,
      });

      return withTenantTransaction(tenant, user, async (tx) => {
        const parentRes = await tx.query<AgentTaskRowDb>(
          `SELECT * FROM agent_tasks WHERE tenant_id = $1 AND id = $2`,
          [tenant.id, input.parentTaskId],
        );
        const parent = parentRes.rows[0];
        if (!parent) throw new RefinementTargetError('parent_not_found');

        // Ownership through the conversation (agent_tasks has no user axis). Locked, never
        // updated: the brief stays untouched.
        const conv = await tx.query(
          `SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenant.id, parent.conversation_id],
        );
        if (conv.rowCount === 0) throw new RefinementTargetError('parent_not_found');
        // Only a finished candidate can be refined; failed tasks are retried without one.
        if (parent.status !== 'completed') throw new RefinementTargetError('parent_not_completed');

        if (refinement.anchorDeliverableId !== null) {
          const anchor = await tx.query(
            `SELECT 1 FROM deliverables
              WHERE tenant_id = $1 AND id = $2 AND agent_task_id = $3`,
            [tenant.id, refinement.anchorDeliverableId, parent.id],
          );
          if (anchor.rowCount === 0) throw new RefinementTargetError('anchor_not_in_parent');
        }

        await tx.query(
          `SELECT 1 FROM agent_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenant.id, parent.iteration_root_id],
        );
        const next = await tx.query<{ n: number }>(
          `SELECT coalesce(max(iteration_number), 0)::int + 1 AS n
             FROM agent_tasks WHERE tenant_id = $1 AND iteration_root_id = $2`,
          [tenant.id, parent.iteration_root_id],
        );
        const iterationNumber = Math.max(next.rows[0].n, 2);

        const base: Record<string, unknown> = { ...parent.requirements_snapshot };
        delete base[REFINEMENT_SNAPSHOT_KEY];
        const snapshot = { ...base, [REFINEMENT_SNAPSHOT_KEY]: refinement };
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
            input.iterationTrigger,
            JSON.stringify(snapshot),
            input.scheduledFor ?? null,
          ],
        );
        const row = agentTaskRowToDomain(res.rows[0]);
        child.info(
          {
            id: row.id,
            iterationNumber,
            observations: refinement.observations.length,
            parameters: Object.keys(refinement.parameterChanges).length,
          },
          'refinement iteration inserted',
        );
        return row;
      });
    },
  };
}

export type RefinementsRepo = ReturnType<typeof refinementsRepo>;
