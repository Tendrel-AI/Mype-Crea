import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listByConversation: vi.fn(), listTasks: vi.fn() }));
vi.mock('../../../repos', () => ({
  repos: () => ({ deliverables: { listByConversation: mocks.listByConversation } }),
  systemRepos: () => ({ agentTasks: { listByConversation: mocks.listTasks } }),
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

  it('reads the recorded inputs (KAN-35): field versions from the artifact metadata, upstream approvals from the task', async () => {
    const base = { conversationId: 'c-1', agentTaskId: 't-1', userId: 'u-1', kind: 'logo', contentUrl: 'https://x/p.png', storageKey: null, selectedAt: null, supersededBy: null, createdAt: '2026-01-01T00:00:01.000Z' };
    mocks.listByConversation.mockResolvedValue([
      { ...base, id: 'd-new', contentInline: null, artifactMetadata: { inputs: { business_name: { value: 'Sol', version: 'sha256:aa' } } } },
      { ...base, id: 'd-text', contentUrl: null, contentInline: { value: 'Sol', metadata: { inputs: { style_keywords: { value: 'x', version: 'sha256:bb' } } } } },
      { ...base, id: 'd-legacy', contentInline: null, artifactMetadata: null },
    ]);
    const task = { agentId: 'logo-agent', status: 'completed', errorCategory: null, error: null, parentTaskId: null, iterationRootId: 't-1', iterationNumber: 1, iterationTrigger: null, createdAt: '2026-01-01T00:00:00.000Z' };
    mocks.listTasks.mockResolvedValue([
      { ...task, id: 't-1', requirementsSnapshot: { business_name: 'Sol', upstream_approvals: { business_name: 'd-name' } } },
      { ...task, id: 't-0', requirementsSnapshot: { business_name: 'Sol' } },
    ]);
    const store = new PostgresDeliverableWorkflowStore('tenant-1' as UUID, 'u-1' as UUID);
    expect((await store.listCandidates('c-1' as ConversationId)).map((c) => c.inputVersions)).toEqual([
      { business_name: 'sha256:aa' },
      { style_keywords: 'sha256:bb' },
      null,
    ]);
    expect((await store.listTasks('c-1' as ConversationId)).map((t) => t.upstreamApprovals)).toEqual([
      { business_name: 'd-name' },
      null,
    ]);
  });
});
