/**
 * MYPES Platform — Local transport adapter
 * =========================================
 *
 * Location: src/transport/local-adapter.ts
 *
 * The Phase 1 implementation of IAgentTransport. Dispatches tasks by calling
 * the agent's handler directly in-process. Task results are stored in an
 * in-memory Map keyed by taskId.
 *
 * The interface is async-shaped even though the implementation is local:
 *   - dispatch() returns a taskId synchronously (wrapped in Promise for
 *     interface conformance), but starts the handler asynchronously via
 *     queueMicrotask. Callers MUST NOT assume dispatch() = completion.
 *   - getResult() returns the current state: pending / processing /
 *     completed / failed.
 *
 * In Phase 2 (BullMQ), dispatch() pushes to Redis and getResult() reads from
 * a shared Postgres table. The interface doesn't change; the orchestrator
 * code doesn't change.
 *
 * See also:
 *   - agent-types.ts      (IAgentTransport contract)
 *   - agent-registry.ts   (source of handlers this adapter resolves)
 *   - docs/agents/architecture.md  (rule 7: agents only via transport)
 */

import type {
  A2AMessage,
  A2ATaskResult,
  IAgentTransport,
  TaskState,
} from '../core/agent-types';
import type { TaskId } from '../core/contracts';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import { loggerFor } from '../services/logger';

const log = loggerFor('transport.local');

/**
 * Settlement hook. May return a promise (the core's `onTaskSettled` does real
 * I/O with the Postgres store); the adapter awaits it before it reports the
 * task as settled, so `waitForSettlement` is a barrier for the whole
 * settlement, not just for the handler.
 */
export type LocalSettlementCallback = (taskId: TaskId, state: TaskState) => void | Promise<void>;

export class LocalAdapter implements IAgentTransport {
  private readonly tasks = new Map<TaskId, TaskState>();
  /** One promise per dispatched task; resolves after the settlement hook has finished. */
  private readonly settlements = new Map<TaskId, Promise<TaskState>>();

  constructor(
    private readonly registry: AgentRegistry,
    /** Hook so the core can be notified without polling. Production swaps this for LISTEN/NOTIFY. */
    private readonly onTaskSettled?: LocalSettlementCallback,
  ) {}

  async dispatch(message: A2AMessage): Promise<{ taskId: TaskId }> {
    const { taskId, agentId } = message;
    this.tasks.set(taskId, { status: 'pending' });

    const entry = this.registry.get(agentId);

    // Fire asynchronously so dispatch() returns before the handler runs —
    // this matches what distributed transports will do and catches code that
    // wrongly assumes dispatch = completion.
    let resolveSettlement!: (state: TaskState) => void;
    this.settlements.set(
      taskId,
      new Promise<TaskState>((resolve) => {
        resolveSettlement = resolve;
      }),
    );
    queueMicrotask(async () => {
      this.tasks.set(taskId, { status: 'processing' });
      let result: A2ATaskResult;
      try {
        result = await entry.handler(message, entry.handlerDeps);
      } catch (err) {
        result = {
          status: 'failed',
          taskId,
          error: {
            kind: 'handler_threw',
            message: err instanceof Error ? err.message : String(err),
          },
          completedAt: new Date().toISOString(),
        };
      }

      const finalState: TaskState =
        result.status === 'completed'
          ? { status: 'completed', result }
          : { status: 'failed', result };

      this.tasks.set(taskId, finalState);
      try {
        // Await the hook: with a real store it performs several round trips
        // before the completion announcement is queued.
        await this.onTaskSettled?.(taskId, finalState);
      } catch (err) {
        // Never leave a floating rejection in a microtask; the task state above
        // stays the source of truth for getResult().
        log.error({ err, taskId, agentId }, 'transport.local.settlement_callback_failed');
      }
      resolveSettlement(finalState);
    });

    return { taskId };
  }

  async getResult(taskId: TaskId): Promise<TaskState> {
    return this.tasks.get(taskId) ?? { status: 'pending' };
  }

  /**
   * Resolves once a dispatched task settles AND the settlement hook has
   * finished (for the core: completion queued, notifier woken). Convenient
   * for tests; production callers use onTaskSettled or the core's decision
   * notifier instead. Rejects for a task this adapter never dispatched.
   */
  waitForSettlement(taskId: TaskId): Promise<TaskState> {
    const settlement = this.settlements.get(taskId);
    if (!settlement) {
      return Promise.reject(new Error(`LocalAdapter never dispatched task ${taskId}`));
    }
    return settlement;
  }
}
