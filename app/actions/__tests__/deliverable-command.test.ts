import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const identity = { tenant: { id: 'tenant-1' }, user: { id: 'user-1' } };
  const readPinnedConversation = vi.fn<() => Promise<any>>(async () => ({ state: 'pinned' }));
  const acceptedVersions = new Set<string>(['terminos-v1']);
  const hasAccepted = vi.fn(async (version: string) => acceptedVersions.has(version));
  const repos = vi.fn(() => ({ conversations: { readPinnedConversation }, termsAcceptances: { hasAccepted } }));
  const startConversation = vi.fn(async () => undefined);
  const executeCommand = vi.fn(async (command: { commandId: string; kind: string }) => ({
    ok: true,
    commandId: command.commandId,
    kind: command.kind,
    replayed: false,
    states: [],
  }));
  const getDeliverableStates = vi.fn(async () => [{ agentId: 'logo-agent', state: 'enabled' }]);
  const resolveIdentity = vi.fn<() => Promise<any>>(async () => identity);
  return { identity, acceptedVersions, hasAccepted, readPinnedConversation, repos, startConversation, executeCommand, getDeliverableStates, resolveIdentity };
});

vi.mock('../../../src/auth/resolve-identity', () => ({ resolveIdentity: mocks.resolveIdentity }));
vi.mock('../../../src/repos', () => ({ repos: mocks.repos }));
vi.mock('../../../src/core/orchestrator/bootstrap-registry', () => ({
  buildDefaultRegistry: () => ({ getFieldSchemas: () => [] }),
}));
vi.mock('../../../src/core/orchestrator/runtime', () => ({
  getOrchestrator: () => ({
    startConversation: mocks.startConversation,
    executeCommand: mocks.executeCommand,
    getDeliverableStates: mocks.getDeliverableStates,
  }),
}));
vi.mock('../../../src/services/logger', () => ({
  loggerFor: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { deliverableCommandAction, loadDeliverableStatesAction } from '../deliverable-command';
import { CURRENT_TERMS_VERSION, TERMS_REQUIRED_MESSAGE } from '../../../src/consent/terms';

const CONVERSATION = '3f1c2a4e-9b7d-4c2e-8f10-0a1b2c3d4e5f';
const COMMAND = '6a8f0d3e-1b2c-4d5e-8f90-123456789abc';
const DELIVERABLE = '9b7d3f1c-2a4e-4c2e-8f10-0a1b2c3d4e5f';

const base = {
  commandId: COMMAND,
  conversationId: CONVERSATION,
  agentId: 'logo-agent',
  expectedState: 'in_review',
  stateToken: 'ds1-0011aabb',
};

describe('deliverableCommandAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPinnedConversation.mockResolvedValue({ state: 'pinned' });
    mocks.acceptedVersions.clear();
    mocks.acceptedVersions.add('terminos-v1');
  });

  describe('KAN-27 consent gate', () => {
    it.each([
      ['never accepted', [] as string[]],
      ['accepted only an older version', ['terminos-v0']],
    ])('rejects a direct command when the user %s, before the core', async (_name, versions) => {
      mocks.acceptedVersions.clear();
      for (const version of versions) mocks.acceptedVersions.add(version);
      const result = await deliverableCommandAction({ ...base, kind: 'generate' });
      expect(result).toMatchObject({ ok: false, code: 'terms_required', reason: 'unavailable', message: TERMS_REQUIRED_MESSAGE });
      expect(mocks.hasAccepted).toHaveBeenCalledWith(CURRENT_TERMS_VERSION);
      expect(mocks.readPinnedConversation).not.toHaveBeenCalled();
      expect(mocks.startConversation).not.toHaveBeenCalled();
      expect(mocks.executeCommand).not.toHaveBeenCalled();
    });

    it('fails closed when the acceptance cannot be verified', async () => {
      mocks.hasAccepted.mockRejectedValueOnce(new Error('db down'));
      const result = await deliverableCommandAction({ ...base, kind: 'generate' });
      expect(result).toMatchObject({ ok: false, code: 'terms_unavailable' });
      expect(mocks.executeCommand).not.toHaveBeenCalled();
    });
  });

  it('authorizes the owner, registers the conversation, and hands the typed command to the core', async () => {
    const result = await deliverableCommandAction({ ...base, kind: 'iterate', deliverableId: DELIVERABLE, observation: 'Más azul' });
    expect(result.ok).toBe(true);
    expect(mocks.repos).toHaveBeenCalledWith(mocks.identity.tenant, mocks.identity.user);
    expect(mocks.startConversation).toHaveBeenCalledWith(CONVERSATION, 'tenant-1', 'user-1');
    expect(mocks.executeCommand).toHaveBeenCalledWith({
      ...base,
      kind: 'iterate',
      deliverableId: DELIVERABLE,
      observation: 'Más azul',
    });
  });

  it('passes approve with a null expectedApprovedId', async () => {
    await deliverableCommandAction({ ...base, kind: 'approve', deliverableId: DELIVERABLE, expectedApprovedId: null });
    expect(mocks.executeCommand).toHaveBeenCalledWith({ ...base, kind: 'approve', deliverableId: DELIVERABLE, expectedApprovedId: null });
  });

  it.each([
    ['unknown kind', { ...base, kind: 'advance' }],
    ['bad command id', { ...base, commandId: 'nope', kind: 'generate' }],
    ['bad expected state', { ...base, expectedState: 'done', kind: 'generate' }],
    ['cancel without task', { ...base, kind: 'cancel' }],
    ['retry without task', { ...base, kind: 'retry' }],
    ['approve without deliverable', { ...base, kind: 'approve' }],
    ['iterate with bad anchor', { ...base, kind: 'iterate', deliverableId: 'logo-1' }],
  ])('rejects %s before touching the core', async (_name, input) => {
    const result = await deliverableCommandAction(input as never);
    expect(result).toMatchObject({ ok: false, reason: 'invalid', message: 'No pudimos validar esta acción.' });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it('rejects an observation over the cap with neutral Spanish', async () => {
    const result = await deliverableCommandAction({ ...base, kind: 'iterate', observation: 'a'.repeat(501) });
    expect(result).toMatchObject({ ok: false, reason: 'invalid', message: 'Tu comentario puede tener hasta 500 caracteres.' });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('refuses a conversation the caller does not own or that is not pinned', async () => {
    mocks.readPinnedConversation.mockResolvedValueOnce(null);
    expect(await deliverableCommandAction({ ...base, kind: 'generate' })).toMatchObject({
      ok: false,
      code: 'conversation_unavailable',
    });
    mocks.readPinnedConversation.mockResolvedValueOnce({ state: 'legacy_unversioned' });
    expect(await deliverableCommandAction({ ...base, kind: 'generate' })).toMatchObject({
      ok: false,
      code: 'legacy_unversioned',
    });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('maps a core exception to a safe retryable message', async () => {
    mocks.executeCommand.mockRejectedValueOnce(new Error('db down'));
    expect(await deliverableCommandAction({ ...base, kind: 'generate' })).toMatchObject({
      ok: false,
      code: 'command_failed',
      message: 'No pudimos completar esta acción. Inténtalo de nuevo.',
    });
  });
});

describe('loadDeliverableStatesAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the server-derived states for an owned conversation', async () => {
    expect(await loadDeliverableStatesAction({ conversationId: CONVERSATION })).toEqual({
      ok: true,
      states: [{ agentId: 'logo-agent', state: 'enabled' }],
    });
    expect(mocks.startConversation).toHaveBeenCalled();
  });

  it('rejects a malformed conversation id and identity failures', async () => {
    expect(await loadDeliverableStatesAction({ conversationId: 'x' })).toMatchObject({ ok: false, code: 'invalid_request' });
    mocks.resolveIdentity.mockRejectedValueOnce(new Error('no session'));
    expect(await loadDeliverableStatesAction({ conversationId: CONVERSATION })).toMatchObject({
      ok: false,
      code: 'identity_unavailable',
    });
  });
});
