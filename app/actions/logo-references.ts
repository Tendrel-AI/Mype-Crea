'use server';

/**
 * D62: the ids and names of the reference images uploaded for the brand of a conversation, shown in the logo box.
 * Owner-scoped like the product-photo listing; a conversation without a brand, or a product conversation, has none.
 */

import { authorizeConversation as authorize, isUuid } from './conversation-access';
import type { ConversationId } from '../../src/core/contracts';
import { logoReferencesOfConversation } from '../../src/logo/logo-task-inputs';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.logo-references');

export type LogoReferenceNamesResult =
  | { readonly ok: true; readonly references: ReadonlyArray<{ readonly id: string; readonly name: string }> }
  | { readonly ok: false };

export async function listLogoReferenceNamesAction(input: { readonly conversationId: string }): Promise<LogoReferenceNamesResult> {
  if (!isUuid(input?.conversationId)) return { ok: false };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorize(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return { ok: false };
  try {
    const found = await logoReferencesOfConversation(authorized.identity.tenant, authorized.identity.user, conversationId);
    return { ok: true, references: (found ?? []).map((ref) => ({ id: ref.fileId, name: ref.originalName })) };
  } catch (error) {
    log.error({ conversationId, err: error }, 'logoReferences.list_failed');
    return { ok: false };
  }
}
