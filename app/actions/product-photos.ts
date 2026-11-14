'use server';

/**
 * The ids and names of the photos uploaded for the product of a conversation, shown in the advertising-photo card.
 * Owner-scoped like the lab-report listing; a conversation without a product has none.
 */

import { authorizeConversation as authorize, isUuid } from './conversation-access';
import type { ConversationId } from '../../src/core/contracts';
import { productPhotosOfConversation } from '../../src/social/ad-task-inputs';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.product-photos');

export type ProductPhotoNamesResult =
  | { readonly ok: true; readonly photos: ReadonlyArray<{ readonly id: string; readonly name: string }> }
  | { readonly ok: false };

export async function listProductPhotoNamesAction(input: { readonly conversationId: string }): Promise<ProductPhotoNamesResult> {
  if (!isUuid(input?.conversationId)) return { ok: false };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorize(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return { ok: false };
  try {
    const found = await productPhotosOfConversation(authorized.identity.tenant, authorized.identity.user, conversationId);
    return { ok: true, photos: (found ?? []).map((photo) => ({ id: photo.fileId, name: photo.originalName })) };
  } catch (error) {
    log.error({ conversationId, err: error }, 'productPhotos.list_failed');
    return { ok: false };
  }
}
