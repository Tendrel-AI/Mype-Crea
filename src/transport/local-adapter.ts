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
 *   - .claude/skills/mypes-architecture/SKILL.md  (rule 7: agents only via transport)
 */

import type {
  A2AMessage,
  A2ATaskResult,
  IAgentTransport,
  TaskState,
} from '../core/agent-types';
import type { TaskId } from '../core/contracts';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';

export class LocalAdapter implements IAgentTransport {
  private readonly tasks = new Map<TaskId, TaskState>();
  private readonly completionCallbacks = new Map<TaskId, (state: TaskState) => void>();

  constructor(
    private readonly registry: AgentRegistry,
    /** Hook so the core can be notified without polling. Production swaps this for LISTEN/NOTIFY. */
    private readonly onTaskSettled?: (taskId: TaskId, state: TaskState) => void,
  ) {}

  async dispatch(message: A2AMessage): Promise<{ taskId: TaskId }> {
    const { taskId, agentId } = message;
    this.tasks.set(taskId, { status: 'pending' });

    const entry = this.registry.get(agentId);

    // Fire asynchronously so dispatch() returns before the handler runs —
    // this matches what distributed transports will do and catches code that
    // wrongly assumes dispatch = completion.
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
      this.completionCallbacks.get(taskId)?.(finalState);
      this.completionCallbacks.delete(taskId);
      this.onTaskSettled?.(taskId, finalState);
    });

    return { taskId };
  }

  async getResult(taskId: TaskId): Promise<TaskState> {
    return this.tasks.get(taskId) ?? { status: 'pending' };
  }

  /**
   * Promise that resolves once a task settles. Convenient for tests; production
   * callers use onTaskSettled or the core's decision notifier instead.
   */
  waitForSettlement(taskId: TaskId): Promise<TaskState> {
    const existing = this.tasks.get(taskId);
    if (existing && (existing.status === 'completed' || existing.status === 'failed')) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.completionCallbacks.set(taskId, resolve);
    });
  }
}