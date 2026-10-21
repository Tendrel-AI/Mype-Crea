import { afterEach, describe, expect, it, vi } from 'vitest';
import { republishPendingDispatches, startPeriodicRecovery } from '../periodic-recovery';
import type { TaskId, UUID } from '../../contracts';

describe('periodic pending-task recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('republishes only the bounded tenant page as task wake-up hints', async () => {
    const tenantId = 'tenant-1' as UUID;
    const rows = [
      { id: 'task-1' as TaskId, agentId: 'logo-agent' },
      { id: 'task-2' as TaskId, agentId: 'logo-agent' },
    ];
    const listPending = vi.fn().mockResolvedValue(rows);
    const publish = vi.fn().mockResolvedValue(1);

    await expect(republishPendingDispatches({
      tenantId,
      agentId: 'logo-agent',
      batchSize: 2,
      listPending,
      publish,
    })).resolves.toBe(2);

    expect(listPending).toHaveBeenCalledWith({ agentId: 'logo-agent', limit: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, rows[0], tenantId);
    expect(publish).toHaveBeenNthCalledWith(2, rows[1], tenantId);
  });

  it('runs immediately and periodically, without overlapping recovery passes', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstPass = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const recover = vi.fn()
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue(undefined);
    const onError = vi.fn();

    const stop = startPeriodicRecovery({ intervalMs: 1_000, recover, onError });
    expect(recover).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recover).toHaveBeenCalledTimes(2);
  });
});
