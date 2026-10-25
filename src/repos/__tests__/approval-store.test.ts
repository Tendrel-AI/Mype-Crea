import { describe, expect, it, vi } from 'vitest';
import {
  createApprovalStoreFromRepo,
  toApproveResult,
  type ApprovalStoreRepo,
} from '../approval-store';
import type { DeliverableApprovalRow } from '../approvals';

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
    markStale: vi.fn(async () => []),
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
      }),
    ).toEqual({
      ok: true,
      approvalId: approval.id,
      replacedDeliverableId: 'd0000000-0000-4000-8000-000000000001',
    });
  });

  it('maps a first approval to ok with no replaced deliverable', () => {
    expect(
      toApproveResult({ kind: 'approved', approval: { ...approval, replacedDeliverableId: null }, replacedDeliverableId: null }),
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
  it('exposes exactly the port methods', () => {
    const store = createApprovalStoreFromRepo(fakeRepo());
    expect(Object.keys(store).sort()).toEqual(['approve', 'getApproved', 'markDependentsStale']);
  });

  it('passes approve input through and maps the outcome', async () => {
    const approve = vi.fn(async () => ({ kind: 'rejected', reason: 'stale' }) as const);
    const store = createApprovalStoreFromRepo(fakeRepo({ approve }));
    const input = {
      conversationId: approval.conversationId,
      deliverableKind: 'logo',
      deliverableId: approval.deliverableId,
      expectedApprovedId: null,
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

  it('delegates markDependentsStale to markStale and resolves to undefined', async () => {
    const markStale = vi.fn(async () => []);
    const store = createApprovalStoreFromRepo(fakeRepo({ markStale }));
    const input = { conversationId: approval.conversationId, deliverableKinds: ['tagline', 'label'] };
    await expect(store.markDependentsStale(input)).resolves.toBeUndefined();
    expect(markStale).toHaveBeenCalledWith(input);
  });

  it('propagates repository errors (e.g. unknown kinds) instead of swallowing them', async () => {
    const markStale = vi.fn(async () => {
      throw new Error('approvals.markStale: unknown deliverable kinds: banner');
    });
    const store = createApprovalStoreFromRepo(fakeRepo({ markStale }));
    await expect(
      store.markDependentsStale({ conversationId: approval.conversationId, deliverableKinds: ['banner'] }),
    ).rejects.toThrow('unknown deliverable kinds');
  });
});
