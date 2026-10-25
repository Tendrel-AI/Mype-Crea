/**
 * Iteration refinement repository (KAN-34 / RF-06, decision KAN-65 R2).
 *
 * Creates an iteration `agent_tasks` row whose `requirements_snapshot` carries the validated,
 * iteration-local refinement under the reserved key `refinement`:
 *   `{ parameterChanges, observations[], anchorDeliverableId }` (caps in src/core/refinement.ts, the single rule).
 *
 * Guarantees (enforced by the shared guarded iteration insert `insertGuardedIteration` in
 * agent-tasks.ts, the same path the KAN-28 Iterar/Reintentar commands use through
 * `agentTasks.insertCommandTask`):
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
 * Unlike `insertCommandTask` (which stores the CURRENT brief and adds the command's idempotency
 * replay and one-active-task guard), this entry point copies the PARENT's requirements. It only
 * persists the row (status `pending`); dispatching it through `IAgentTransport` is the caller's
 * job. The production command path does not call it today (see docs/agents/database.md).
 */
import type { TaskId, UUID } from '../core/contracts';
import { withTenantTransaction, type Tenant, type User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { insertGuardedIteration, type IterationTargetRejection } from './agent-tasks';
import { isUuid } from './approvals';
import type { AgentTaskRow, IterationTrigger } from './models';
import {
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
  constructor(readonly reason: IterationTargetRejection) {
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
        const inserted = await insertGuardedIteration(tx, tenant, {
          parentTaskId: input.parentTaskId,
          trigger: input.iterationTrigger,
          idempotencyKey: input.idempotencyKey,
          agentCardVersion: input.agentCardVersion,
          baseRequirements: 'parent',
          refinement,
          scheduledFor: input.scheduledFor,
        });
        if (!inserted.ok) throw new RefinementTargetError(inserted.reason);
        const row = inserted.row;
        child.info(
          {
            id: row.id,
            iterationNumber: row.iterationNumber,
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
