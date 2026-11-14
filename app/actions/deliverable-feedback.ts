'use server';

/**
 * Deliverable feedback controller (prompt ledger step 4, F13 / D21): 👍 / 👎 on a generated
 * version. Only the conversation owner can rate (owner-scoped access + KAN-27 consent); the
 * prompt version is copied server-side by the repo, never read from the client.
 */

import { authorizeConversation as authorize, isUuid, type AccessFailureCode } from './conversation-access';
import { repos } from '../../src/repos';
import type { FeedbackValue } from '../../src/repos/deliverable-feedback';
import type { ConversationId, UUID } from '../../src/core/contracts';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.deliverable-feedback');

type FailureCode = AccessFailureCode | 'invalid_request' | 'feedback_failed';
type Failure = { readonly ok: false; readonly code: FailureCode; readonly message: string };

const MESSAGES = {
  invalid: 'No pudimos validar tu calificación.',
  failed: 'No pudimos guardar tu calificación. Inténtalo de nuevo.',
  loadFailed: 'No pudimos cargar tus calificaciones.',
} as const;

/** Rate (or clear with `null`) one deliverable version of the caller's own conversation. */
export async function deliverableFeedbackAction(input: {
  readonly conversationId: string;
  readonly deliverableId: string;
  readonly value: string | null;
}): Promise<{ readonly ok: true; readonly value: FeedbackValue | null } | Failure> {
  const { conversationId, deliverableId, value } = input ?? ({} as typeof input);
  if (!isUuid(conversationId) || !isUuid(deliverableId) || (value !== null && value !== 'up' && value !== 'down')) {
    return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
  }
  const authorized = await authorize(conversationId as ConversationId, { requireDurability: false, requireTerms: true });
  if (!authorized.ok) return authorized;
  try {
    const stored = await repos(authorized.identity.tenant, authorized.identity.user).deliverableFeedback.set(
      conversationId as ConversationId,
      deliverableId as UUID,
      value,
    );
    if (!stored.found) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
    log.debug({ conversationId, deliverableId, value: stored.value }, 'deliverableFeedback.saved');
    return { ok: true, value: stored.value };
  } catch (error) {
    log.error({ conversationId, deliverableId, err: error }, 'deliverableFeedback.failed');
    return { ok: false, code: 'feedback_failed', message: MESSAGES.failed };
  }
}

/** The caller's ratings of a conversation's deliverables (shown again on reload), by deliverable id. */
export async function loadDeliverableFeedbackAction(input: {
  readonly conversationId: string;
}): Promise<{ readonly ok: true; readonly feedback: Readonly<Record<string, FeedbackValue>> } | Failure> {
  if (!isUuid(input?.conversationId)) return { ok: false, code: 'invalid_request', message: MESSAGES.invalid };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorize(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return authorized;
  try {
    const feedback = await repos(authorized.identity.tenant, authorized.identity.user).deliverableFeedback.listByConversation(conversationId);
    return { ok: true, feedback };
  } catch (error) {
    log.error({ conversationId, err: error }, 'deliverableFeedback.load_failed');
    return { ok: false, code: 'feedback_failed', message: MESSAGES.loadFailed };
  }
}
