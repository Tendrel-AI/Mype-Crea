import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };
  const readPinnedConversation = vi.fn<() => Promise<any>>(async () => ({ state: 'pinned' }));
  const hasAccepted = vi.fn(async () => true);
  const set = vi.fn<(...args: unknown[]) => Promise<any>>(async (_c, _d, value) => ({ found: true, value }));
  const listByConversation = vi.fn(async () => ({}));
  const repos = vi.fn(() => ({
    conversations: { readPinnedConversation },
    termsAcceptances: { hasAccepted },
    deliverableFeedback: { set, listByConversation },
  }));
  const resolveIdentity = vi.fn<() => Promise<any>>(async () => identity);
  return { readPinnedConversation, hasAccepted, set, listByConversation, repos, resolveIdentity };
});

vi.mock('../../../src/auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/bootstrap-registry', () => ({ buildDefaultRegistry: () => ({ getFieldSchemas: () => [] }) }));
vi.mock('../../../src/core/orchestrator/runtime', () => ({ getOrchestrator: () => ({ startConversation: vi.fn(async () => undefined) }) }));
vi.mock('../../../src/services/logger', () => ({ loggerFor: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));

import { deliverableFeedbackAction, loadDeliverableFeedbackAction } from '../deliverable-feedback';

const CONVERSATION = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f';
const DELIVERABLE = '9b7d3f1c-2a4e-4c2e-8f10-0a1b2c3d4e5f';

describe('deliverableFeedbackAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPinnedConversation.mockResolvedValue({ state: 'pinned' });
    mocks.hasAccepted.mockResolvedValue(true);
    mocks.set.mockImplementation(async (_c, _d, value) => ({ found: true, value }));
  });

  it.each([
    [{ conversationId: 'x', deliverableId: DELIVERABLE, value: 'up' }],
    [{ conversationId: CONVERSATION, deliverableId: 'x', value: 'up' }],
    [{ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value: 'meh' }],
    [{ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value: undefined }],
  ])('rejects invalid input before touching anything', async (input) => {
    expect(await deliverableFeedbackAction(input as never)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(['up', 'down', null])('stores %s for the owner', async (value) => {
    expect(await deliverableFeedbackAction({ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value })).toEqual({ ok: true, value });
    expect(mocks.set).toHaveBeenCalledWith(CONVERSATION, DELIVERABLE, value);
  });

  it('refuses a conversation the caller does not own', async () => {
    mocks.readPinnedConversation.mockResolvedValue(null);
    expect(await deliverableFeedbackAction({ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value: 'up' })).toMatchObject({ ok: false, code: 'conversation_unavailable' });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('requires accepted terms', async () => {
    mocks.hasAccepted.mockResolvedValue(false);
    expect(await deliverableFeedbackAction({ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value: 'up' })).toMatchObject({ ok: false, code: 'terms_required' });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('refuses a deliverable that is not the caller\'s and reports storage failures in Spanish', async () => {
    mocks.set.mockResolvedValueOnce({ found: false, value: null });
    expect(await deliverableFeedbackAction({ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value: 'up' })).toMatchObject({ ok: false, code: 'invalid_request' });
    mocks.set.mockRejectedValueOnce(new Error('db down'));
    const failed = await deliverableFeedbackAction({ conversationId: CONVERSATION, deliverableId: DELIVERABLE, value: 'up' });
    expect(failed).toMatchObject({ ok: false, code: 'feedback_failed', message: 'No pudimos guardar tu calificación. Inténtalo de nuevo.' });
  });
});

describe('loadDeliverableFeedbackAction', () => {
  it('returns the owner ratings', async () => {
    mocks.listByConversation.mockResolvedValueOnce({ [DELIVERABLE]: 'down' } as never);
    expect(await loadDeliverableFeedbackAction({ conversationId: CONVERSATION })).toEqual({ ok: true, feedback: { [DELIVERABLE]: 'down' } });
    expect(await loadDeliverableFeedbackAction({ conversationId: 'x' })).toMatchObject({ ok: false, code: 'invalid_request' });
  });
});
