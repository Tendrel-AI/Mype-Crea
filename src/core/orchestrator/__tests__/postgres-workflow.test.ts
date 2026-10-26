import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listByConversation: vi.fn() }));
vi.mock('../../../repos', () => ({
  repos: () => ({ deliverables: { listByConversation: mocks.listByConversation } }),
  systemRepos: () => ({ agentTasks: {} }),
}));

import { PostgresDeliverableWorkflowStore } from '../postgres-workflow';
import type { ConversationId, UUID } from '../../contracts';

describe('PostgresDeliverableWorkflowStore candidates (KAN-52)', () => {
  it('hands the views the asset route for a stored image and the stored URL for a legacy row', async () => {
    const base = { conversationId: 'c-1', agentTaskId: 't-1', userId: 'u-1', kind: 'logo', contentInline: null, selectedAt: null, supersededBy: null };
    mocks.listByConversation.mockResolvedValue([
      { ...base, id: 'd-stored', contentUrl: 'https://fal.example/p.png', storageKey: 'tenants/x/0.png', createdAt: '2026-01-01T00:00:01.000Z' },
      { ...base, id: 'd-legacy', contentUrl: 'https://fal.example/old.png', storageKey: null, createdAt: '2026-01-01T00:00:02.000Z' },
    ]);
    const store = new PostgresDeliverableWorkflowStore('tenant-1' as UUID, 'u-1' as UUID);
    const candidates = await store.listCandidates('c-1' as ConversationId);
    expect(candidates.map((c) => [c.deliverableId, c.contentUrl])).toEqual([
      ['d-stored', '/api/assets/d-stored'],
      ['d-legacy', 'https://fal.example/old.png'],
    ]);
  });
});
