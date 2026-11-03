import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  withAuth: vi.fn(),
  requireGlobalAdmin: vi.fn(),
  requireGlobalMfa: vi.fn(),
  resolveHomeConversation: vi.fn(),
  currentTermsStatus: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
}));

vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: mocks.withAuth }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../src/auth/resolve-identity', () => ({
  requireGlobalAdmin: mocks.requireGlobalAdmin,
  requireGlobalMfa: mocks.requireGlobalMfa,
}));
vi.mock('../../src/conversations/selection', () => ({ resolveHomeConversation: mocks.resolveHomeConversation }));
vi.mock('../../components/CreaMype', () => ({ default: () => null }));
vi.mock('../../components/crea-mype/TermsConsent', () => ({ TermsConsent: () => null }));
vi.mock('../../src/consent/gate', () => ({ currentTermsStatus: mocks.currentTermsStatus }));

import Home from '../page';
import { CURRENT_TERMS } from '../../src/consent/terms';

type Props = Record<string, unknown>;
const page = (conversationId?: string | string[]) =>
  Home({ searchParams: Promise.resolve(conversationId === undefined ? {} : { conversationId }) });

const LIST = [{ conversationId: '11111111-1111-4111-8111-111111111111', label: 'Café Andino · 24 oct', lastActivityAt: '2026-10-24T15:00:00.000Z' }];

describe('/ conversation selection (KAN-25)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAuth.mockResolvedValue({ user: { email: 'ana@example.invalid', firstName: 'Ana', lastName: 'Quispe' } });
    mocks.requireGlobalAdmin.mockRejectedValue(new Error('not a platform admin'));
    mocks.currentTermsStatus.mockResolvedValue('accepted');
  });

  it('KAN-27: shows the current terms before any conversation is selected or created', async () => {
    mocks.currentTermsStatus.mockResolvedValueOnce('required');
    const element = await page() as ReactElement<Props>;
    expect(element.props).toEqual({ terms: CURRENT_TERMS });
    expect(mocks.resolveHomeConversation).not.toHaveBeenCalled();
  });

  it('KAN-27: fails closed with an error when the acceptance cannot be verified', async () => {
    mocks.currentTermsStatus.mockResolvedValueOnce('unavailable');
    const element = await page(LIST[0].conversationId) as ReactElement<Props>;
    expect(element.props).toMatchObject({
      initialConversationId: '',
      initialError: 'No pudimos verificar tu aceptación de los términos. Inténtalo de nuevo.',
    });
    expect(mocks.resolveHomeConversation).not.toHaveBeenCalled();
  });

  it('without an id, redirects to the conversation the server selected (resumed or new)', async () => {
    mocks.resolveHomeConversation.mockResolvedValueOnce({ kind: 'redirect', conversationId: LIST[0].conversationId, created: false });
    await expect(page()).rejects.toThrow(`redirect:/?conversationId=${LIST[0].conversationId}`);
    expect(mocks.resolveHomeConversation).toHaveBeenCalledWith(undefined);

    mocks.resolveHomeConversation.mockResolvedValueOnce({ kind: 'redirect', conversationId: '77777777-7777-4777-8777-777777777777', created: true });
    await expect(page()).rejects.toThrow('redirect:/?conversationId=77777777-7777-4777-8777-777777777777');
  });

  it('opens an owned conversation with turns, deliverables and the list', async () => {
    const history = {
      conversationId: LIST[0].conversationId,
      turns: [{ requestId: 'r1', userMessage: 'Hola', content: '¡Hola!', stage: 'responded', failureCategory: null, notices: [], createdAt: 'x' }],
      deliverables: [{ id: 'd1', kind: 'logo', contentUrl: '/api/assets/d1', contentInline: null, selectedAt: null, createdAt: 'x' }],
    };
    mocks.resolveHomeConversation.mockResolvedValueOnce({ kind: 'open', history, conversations: LIST });
    const element = await page(LIST[0].conversationId) as ReactElement<Props>;
    expect(mocks.resolveHomeConversation).toHaveBeenCalledWith(LIST[0].conversationId);
    expect(element.key).toBe(LIST[0].conversationId);
    expect(element.props).toMatchObject({
      initialConversationId: LIST[0].conversationId,
      initialTurns: history.turns,
      initialDeliverables: history.deliverables,
      initialConversations: LIST,
      userName: 'Ana Quispe',
    });
    expect(element.props.conversationNotFound).toBeUndefined();
  });

  it('renders one identical not-found page and passes the raw value to the server check', async () => {
    const notFound = { kind: 'not_found', message: 'No encontramos esta conversación.', conversations: LIST };
    const rendered: Props[] = [];
    for (const id of ['44444444-4444-4444-8444-444444444444', 'not-a-uuid', ['a', 'b']]) {
      mocks.resolveHomeConversation.mockResolvedValueOnce(notFound);
      rendered.push((await page(id) as ReactElement<Props>).props);
    }
    expect(mocks.resolveHomeConversation.mock.calls.map(([id]) => id))
      .toEqual(['44444444-4444-4444-8444-444444444444', 'not-a-uuid', ['a', 'b']]);
    for (const props of rendered) {
      expect(props).toEqual(rendered[0]);
      expect(props).toMatchObject({ initialConversationId: '', conversationNotFound: true, initialConversations: LIST });
      expect(props.initialTurns).toBeUndefined();
      expect(props.initialDeliverables).toBeUndefined();
    }
  });

  it('shows a safe error when nothing can be opened or created', async () => {
    mocks.resolveHomeConversation.mockResolvedValueOnce({ kind: 'error', message: 'No pudimos iniciar la conversación. Inténtalo de nuevo.' });
    const element = await page() as ReactElement<Props>;
    expect(element.props).toMatchObject({ initialConversationId: '', initialError: 'No pudimos iniciar la conversación. Inténtalo de nuevo.' });
  });

  it('sends platform admins to the platform before selecting any conversation', async () => {
    mocks.requireGlobalAdmin.mockResolvedValueOnce({});
    mocks.requireGlobalMfa.mockRejectedValueOnce(new Error('MFA required'));
    await expect(page()).rejects.toThrow('redirect:/platform/mfa');
    expect(mocks.resolveHomeConversation).not.toHaveBeenCalled();
  });
});
