import { describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async (_t: unknown, _u: unknown, work: (tx: { query: typeof query }) => unknown) => work({ query }),
}));

import { creditsRepo } from '../credits';

describe('creditsRepo.summary', () => {
  it('maps the single aggregate row, including the month breakdown, and binds the policy zone', async () => {
    query.mockResolvedValue({ rows: [{ balance: '42.5', granted: '100', llm: '50', image: '7.5', cur: '12', prev: '3' }] });
    const s = await creditsRepo({ id: 't' } as never, { id: 'u' } as never).summary();
    expect(s).toEqual({ balanceUsd: 42.5, grantedUsd: 100, consumptionByKind: { llm: 50, image: 7.5 }, consumptionByMonth: { current: 12, previous: 3 } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['t', 'America/Lima']);
  });
});
