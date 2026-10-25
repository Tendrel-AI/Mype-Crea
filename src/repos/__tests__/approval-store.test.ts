import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '../../db/with-transaction';

/**
 * Fake transaction runner: records every transaction and whether it committed or rolled back.
 * The real rollback is Postgres's job (approvals.integration.test.ts); here we prove that the
 * stale marks are written inside the approval's single transaction.
 */
const txLog = vi.hoisted(() => ({
  transactions: [] as Array<{ queries: string[]; outcome: 'commit' | 'rollback' | 'open' }>,
  handler: null as null | ((sql: string, params: unknown[]) => { rows: unknown[] }),
}));
vi.mock('../../db/with-transaction', () => ({
  withTenantTransaction: async <T>(_t: unknown, _u: unknown, fn: (tx: TxClient) => Promise<T>): Promise<T> => {
    const entry = { queries: [] as string[], outcome: 'open' as 'commit' | 'rollback' | 'open' };
    txLog.transactions.push(entry);
    const tx = {
      query: async (sql: string, params: unknown[] = []) => {
        entry.queries.push(sql.replace(/\s+/g, ' ').trim());
        return txLog.handler!(sql, params);
      },
    } as unknown as TxClient;
    try {
      const result = await fn(tx);
      entry.outcome = 'commit';
      return result;
    } catch (err) {
      entry.outcome = 'rollback';
      throw err;
    }
  },
  withTenantAdminTransaction: async () => {
    throw new Error('not used');
  },
}));

import {
  createApprovalStoreFromRepo,
  toApproveResult,
  type ApprovalStoreRepo,
} from '../approval-store';
import { approvalsRepo, type DeliverableApprovalRow } from '../approvals';

const approval: DeliverableApprovalRow = {
  id: 'a0000000-0000-4000-8000-000000000001',
  conversationId: 'c0000000-0000-4000-8000-000000000001',
  userId: 'u0000000-0000-4000-8000-000000000001',
  deliverableKind: 'logo',
  deliverableId: 'd0000000-0000-4000-8000-000000000002',
  replacedDeliverableId: 'd0000000-0000-4000-8000-000000000001',
  approvedBy: 'u0000000-0000-4000-8000-000000000001',
  approvedAt: '2026-10-25T12:00:00.000Z',
  eventSeq: 7,
};

function fakeRepo(overrides: Partial<ApprovalStoreRepo> = {}): ApprovalStoreRepo {
  return {
    approve: vi.fn(async () => ({ kind: 'rejected', reason: 'not_found' }) as const),
    getApproved: vi.fn(async () => []),
    listStale: vi.fn(async () => []),
    ...overrides,
  };
}

describe('toApproveResult', () => {
  it('maps an approval to ok with the approval id and the replaced deliverable', () => {
    expect(
      toApproveResult({
        kind: 'approved',
        approval,
        replacedDeliverableId: approval.replacedDeliverableId,
        staleMarks: [],
      }),
    ).toEqual({
      ok: true,
      approvalId: approval.id,
      replacedDeliverableId: 'd0000000-0000-4000-8000-000000000001',
    });
  });

  it('maps a first approval to ok with no replaced deliverable', () => {
    expect(
      toApproveResult({ kind: 'approved', approval: { ...approval, replacedDeliverableId: null }, replacedDeliverableId: null, staleMarks: [] }),
    ).toEqual({ ok: true, approvalId: approval.id, replacedDeliverableId: null });
  });

  it('maps an idempotent re-approval to ok with the existing approval and nothing replaced', () => {
    expect(toApproveResult({ kind: 'unchanged', approval })).toEqual({
      ok: true,
      approvalId: approval.id,
      replacedDeliverableId: null,
    });
  });

  it.each(['stale', 'not_candidate', 'not_found'] as const)('maps rejection %s', (reason) => {
    expect(toApproveResult({ kind: 'rejected', reason })).toEqual({ ok: false, reason });
  });
});

describe('createApprovalStoreFromRepo', () => {
  it('exposes exactly the port methods (no separate, non-atomic stale-mark write)', () => {
    const store = createApprovalStoreFromRepo(fakeRepo());
    expect(Object.keys(store).sort()).toEqual(['approve', 'getApproved', 'getStaleKinds']);
  });

  it('reads the persisted stale kinds from listStale', async () => {
    const listStale = vi.fn(async () => [
      { deliverableKind: 'label' as const, markedAt: approval.approvedAt },
      { deliverableKind: 'tagline' as const, markedAt: approval.approvedAt },
    ]);
    const store = createApprovalStoreFromRepo(fakeRepo({ listStale }));
    await expect(store.getStaleKinds(approval.conversationId)).resolves.toEqual(['label', 'tagline']);
    expect(listStale).toHaveBeenCalledWith(approval.conversationId);
  });

  it('passes approve input through and maps the outcome', async () => {
    const approve = vi.fn(async () => ({ kind: 'rejected', reason: 'stale' }) as const);
    const store = createApprovalStoreFromRepo(fakeRepo({ approve }));
    const input = {
      conversationId: approval.conversationId,
      deliverableKind: 'logo',
      deliverableId: approval.deliverableId,
      expectedApprovedId: null,
      dependentKinds: ['label', 'social_pack'],
    };
    await expect(store.approve(input)).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(approve).toHaveBeenCalledWith(input);
  });

  it('returns only the port fields from getApproved', async () => {
    const getApproved = vi.fn(async () => [
      { deliverableKind: 'logo' as const, deliverableId: approval.deliverableId, approvedAt: approval.approvedAt, extra: 1 },
    ]);
    const store = createApprovalStoreFromRepo(fakeRepo({ getApproved }));
    await expect(store.getApproved(approval.conversationId)).resolves.toEqual([
      { deliverableKind: 'logo', deliverableId: approval.deliverableId, approvedAt: approval.approvedAt },
    ]);
  });

  it('propagates repository errors (e.g. a failed stale mark) instead of swallowing them', async () => {
    const approve = vi.fn(async () => {
      throw new Error('approvals.approve: unknown deliverable kinds: banner');
    });
    const store = createApprovalStoreFromRepo(fakeRepo({ approve }));
    await expect(
      store.approve({
        conversationId: approval.conversationId,
        deliverableKind: 'logo',
        deliverableId: approval.deliverableId,
        expectedApprovedId: null,
        dependentKinds: ['banner'],
      }),
    ).rejects.toThrow('unknown deliverable kinds');
  });
});

describe('approvalsRepo.approve — approval and stale marks share one transaction (KAN-34)', () => {
  const tenant = { id: 't0000000-0000-4000-8000-000000000001' };
  const user = { id: approval.userId };
  const conv = 'c0000000-0000-4000-8000-000000000001';
  const oldId = 'd0000000-0000-4000-8000-000000000001';
  const newId = 'd0000000-0000-4000-8000-000000000002';
  const now = new Date('2026-10-25T12:00:00.000Z');

  function db(opts: { failMarks?: boolean } = {}) {
    let seq = 10;
    txLog.handler = (sql, params) => {
      if (/FROM conversations/.test(sql)) return { rows: [{ user_id: user.id }] };
      if (/selected_at IS NOT NULL/.test(sql)) return { rows: [{ id: oldId }] };
      if (/JOIN agent_tasks/.test(sql)) return { rows: [{ conversation_id: conv, kind: 'logo', task_status: 'completed' }] };
      if (/^\s*UPDATE deliverables/.test(sql)) return { rows: [] };
      if (/INSERT INTO deliverable_approvals/.test(sql)) {
        return {
          rows: [{
            id: approval.id, conversation_id: conv, user_id: user.id, deliverable_kind: 'logo',
            deliverable_id: newId, replaced_deliverable_id: oldId, approved_by: user.id,
            approved_at: now, event_seq: String((seq += 1)),
          }],
        };
      }
      if (/INSERT INTO deliverable_stale_marks/.test(sql)) {
        if (opts.failMarks) throw Object.assign(new Error('synthetic stale-mark failure'), { code: 'XX000' });
        return {
          rows: (params[4] as string[]).map((k, i) => ({
            id: `m${i}`, conversation_id: conv, deliverable_kind: k, marked_by: user.id,
            marked_at: now, event_seq: String((seq += 1)),
          })),
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    };
  }

  const input = {
    conversationId: conv,
    deliverableKind: 'logo',
    deliverableId: newId,
    expectedApprovedId: oldId,
    dependentKinds: ['label', 'social_pack'],
  };

  beforeEach(() => {
    txLog.transactions.length = 0;
  });

  it('writes the approval row, then the dependents\' marks, in the same committed transaction', async () => {
    db();
    const outcome = await approvalsRepo(tenant, user).approve(input);
    expect(outcome).toMatchObject({ kind: 'approved', replacedDeliverableId: oldId });
    expect(outcome.kind === 'approved' && outcome.staleMarks.map((m) => m.deliverableKind)).toEqual(['label', 'social_pack']);
    expect(outcome.kind === 'approved' && outcome.staleMarks[0].eventSeq).toBeGreaterThan(
      outcome.kind === 'approved' ? outcome.approval.eventSeq : Infinity,
    );
    expect(txLog.transactions).toHaveLength(1);
    const [tx] = txLog.transactions;
    expect(tx.outcome).toBe('commit');
    const approvalAt = tx.queries.findIndex((q) => q.startsWith('INSERT INTO deliverable_approvals'));
    const marksAt = tx.queries.findIndex((q) => q.startsWith('INSERT INTO deliverable_stale_marks'));
    expect(approvalAt).toBeGreaterThan(-1);
    expect(marksAt).toBeGreaterThan(approvalAt);
  });

  it('a failure while writing the marks fails the whole transaction (rolled back, error propagates)', async () => {
    db({ failMarks: true });
    await expect(approvalsRepo(tenant, user).approve(input)).rejects.toThrow('synthetic stale-mark failure');
    expect(txLog.transactions).toHaveLength(1);
    expect(txLog.transactions[0].outcome).toBe('rollback');
    expect(txLog.transactions[0].queries.some((q) => q.startsWith('INSERT INTO deliverable_approvals'))).toBe(true);
  });

  it('writes no marks when nothing depends on the kind', async () => {
    db();
    const outcome = await approvalsRepo(tenant, user).approve({ ...input, dependentKinds: [] });
    expect(outcome.kind === 'approved' && outcome.staleMarks).toEqual([]);
    expect(txLog.transactions[0].queries.some((q) => q.includes('deliverable_stale_marks'))).toBe(false);
  });

  it('rejects unknown dependents and a self-dependency before opening any transaction', async () => {
    db();
    const repo = approvalsRepo(tenant, user);
    await expect(repo.approve({ ...input, dependentKinds: ['banner'] })).rejects.toThrow('unknown deliverable kinds: banner');
    await expect(repo.approve({ ...input, dependentKinds: ['label', 'logo'] })).rejects.toThrow('cannot depend on itself');
    expect(txLog.transactions).toHaveLength(0);
  });
});
