/**
 * KAN-81: a completion notice rebuilt by reconciliation places the logo in
 * the panel live, exactly as the live notice does. Both notices come from the
 * real repository code (`settleTaskAndEnqueue` / `enqueueSettledTaskEvents`)
 * over a mocked transaction, then go through the client parser and the panel.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/db/with-transaction', () => ({
  withTenantTransaction: async (_tenant: unknown, _user: unknown, work: (tx: { query: typeof mocked.query }) => unknown) =>
    work({ query: mocked.query }),
  withTenantAdminTransaction: vi.fn(),
}));

import type { ConversationId, TaskId } from '../../../src/core/contracts';
import { CLIENT_NOTIFICATION_KINDS, parseNotification } from '../../../src/core/contracts/notifications';
import { aiTurnsRepo } from '../../../src/repos/ai-turns';
import { completedLogoUrl } from '../live-logo';
import { Dashboard } from '../Dashboard';
import type { BrandAssets } from '../types';

const OWNER = [{ id: 'tenant-a' }, { id: 'user-a' }] as const;
const CONVERSATION = 'conversation-a' as ConversationId;
const TASK = 'task-a' as TaskId;
const LOGO_URL = 'https://example.invalid/synthetic.png';
const EMPTY: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };

/** The `task_completed` notice the last outbox insert carries, parsed as the browser does. */
function lastNotice() {
  const insert = mocked.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO ai_turn_events')).at(-1);
  expect(insert).toBeDefined();
  const parsed = parseNotification(JSON.parse(String(insert![1][6])), CLIENT_NOTIFICATION_KINDS);
  if (!parsed.ok || parsed.notification.kind !== 'task_completed') throw new Error('expected a task_completed notice');
  return parsed.notification;
}

describe('live logo from a reconciled completion (KAN-81)', () => {
  beforeEach(() => { mocked.query.mockReset(); });

  it('a rebuilt logo notice places the logo in the panel, like the live one', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_tasks t') && sql.includes('FOR UPDATE')) return { rows: [{ agent_id: 'logo-agent', status: 'in_progress' }] };
      if (sql.includes('INSERT INTO deliverables')) return { rows: [{ id: 'deliverable-a' }] };
      return { rows: [], rowCount: 1 };
    });
    await aiTurnsRepo(...OWNER).settleTaskAndEnqueue({
      conversationId: CONVERSATION, taskId: TASK, state: 'completed', deliverableKind: 'logo',
      artifacts: [{ kind: 'image', url: LOGO_URL, metadata: { purpose: 'logo' } }],
    });
    const live = lastNotice();
    const stored = mocked.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO deliverables'))![1];

    // Reconciliation: the projection returns what was stored (content_url, artifact_kind, artifact_metadata).
    mocked.query.mockReset();
    mocked.query.mockImplementation(async (sql: string) => sql.includes('FROM agent_tasks t')
      ? { rows: [{
          taskId: TASK, agentId: 'logo-agent', status: 'completed', errorCategory: null, error: null, deliverableIds: ['deliverable-a'],
          artifacts: [{ kind: stored[7], url: stored[5], inline: null, metadata: JSON.parse(String(stored[8])) }],
        }] }
      : { rows: [], rowCount: 1 });
    await aiTurnsRepo(...OWNER).enqueueSettledTaskEvents({ conversationId: CONVERSATION, taskId: TASK });
    const rebuilt = lastNotice();

    expect(rebuilt.artifacts.map((artifact) => artifact.kind)).toEqual(live.artifacts.map((artifact) => artifact.kind));
    expect(completedLogoUrl(rebuilt)).toBe(LOGO_URL);
    expect(completedLogoUrl(live)).toBe(LOGO_URL);
    const panel = renderToStaticMarkup(
      <Dashboard assets={{ ...EMPTY, logoUrl: completedLogoUrl(rebuilt)! }} processingAgents={new Set()} step={3} setActiveTab={() => {}} />,
    );
    expect(panel).toContain(`<img src="${LOGO_URL}" alt="Logo"`);
  });

  it('places nothing for another agent or a non-image artifact', () => {
    const base = { taskId: TASK, deliverableIds: [], artifacts: [{ kind: 'image', url: LOGO_URL, inline: null, metadata: {} }] };
    expect(completedLogoUrl({ ...base, agentId: 'name-agent' })).toBeNull();
    expect(completedLogoUrl({ ...base, agentId: 'logo-agent', artifacts: [{ kind: 'logo', url: LOGO_URL, inline: null, metadata: {} }] })).toBeNull();
  });
});
