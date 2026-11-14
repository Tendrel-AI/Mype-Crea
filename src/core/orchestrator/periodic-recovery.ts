import type { TaskId, UUID } from '../contracts';

export interface PeriodicRecoveryOptions {
  /** Recovery runs immediately once, then at this interval. */
  readonly intervalMs: number;
  readonly recover: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface PendingDispatch {
  readonly id: TaskId;
  readonly agentId: string;
}

/** Publish one bounded, tenant-scoped page of due tasks as wake-up hints. */
export async function republishPendingDispatches(input: {
  readonly tenantId: UUID;
  readonly agentId: string;
  readonly batchSize: number;
  readonly listPending: (input: { agentId: string; limit: number }) => Promise<PendingDispatch[]>;
  readonly publish: (task: PendingDispatch, tenantId: UUID) => Promise<unknown>;
}): Promise<number> {
  const pending = await input.listPending({
    agentId: input.agentId,
    limit: input.batchSize,
  });
  await Promise.all(pending.map((task) => input.publish(task, input.tenantId)));
  return pending.length;
}

/**
 * Runs one recovery pass at a time. The immediate pass runs after the caller
 * has established any required subscriptions; later passes repair lost wakeups.
 */
export function startPeriodicRecovery(options: PeriodicRecoveryOptions): () => void {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('Recovery interval must be a positive number of milliseconds');
  }

  let stopped = false;
  let running = false;
  const run = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await options.recover();
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), options.intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
