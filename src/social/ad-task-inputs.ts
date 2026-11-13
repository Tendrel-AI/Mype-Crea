/**
 * Product ad photo, server side: how a product's facts and photos reach the social-agent.
 * Same hook as the label-agent (`labelTaskInputs`): `socialTaskInputs` is merged into `taskInputsFor` in runtime.ts
 * and its result is recorded in `requirements_snapshot`. Server-only.
 */
import type { ConversationId, UUID } from '../core/contracts';
import { repos } from '../repos';
import type { Tenant, User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { PRODUCT_FACTS_KEY, PRODUCT_PHOTOS_KEY, SOCIAL_AGENT_ID, type ProductPhotoRef } from './refs';

const log = loggerFor('social.ad-inputs');

const FACT_KEYS = ['food_denomination', 'package_type', 'product_composition', 'consumption_moments', 'price_pen', 'product_presentations'] as const;

/** The product's image uploads (`kind: 'asset'`, oldest first), or null when it is not a product conversation. */
export async function productPhotosOfConversation(
  tenant: Tenant,
  user: User,
  conversationId: ConversationId,
): Promise<ReadonlyArray<ProductPhotoRef & { readonly fileId: UUID }> | null> {
  const owned = repos(tenant, user);
  const context = await owned.conversations.context(conversationId);
  if (!context?.productId || !context.brandId) return null;
  const files = await owned.brandFiles.listByBrand(context.brandId);
  return files
    .filter((f) => f.productId === context.productId && f.kind === 'asset' && f.contentType.startsWith('image/'))
    .map((f) => ({ fileId: f.id, storageKey: f.storageKey, contentType: f.contentType, originalName: f.originalName }));
}

/** The task inputs of one owner's conversations (a `DeliverableCommandContext.taskInputs`). */
export function socialTaskInputs(tenant: Tenant, user: User) {
  return async (conversationId: ConversationId, agentId: string): Promise<Record<string, unknown>> => {
    if (agentId !== SOCIAL_AGENT_ID) return {};
    const owned = repos(tenant, user);
    const context = await owned.conversations.context(conversationId);
    if (!context?.productId) return {};
    const [product, photos] = await Promise.all([
      owned.products.get(context.productId),
      productPhotosOfConversation(tenant, user, conversationId),
    ]);
    const attributes = (product?.attributes ?? {}) as Record<string, unknown>;
    const facts = Object.fromEntries(FACT_KEYS.flatMap((key) => (attributes[key] === undefined || attributes[key] === null ? [] : [[key, attributes[key]]])));
    log.debug({ conversationId, factKeys: Object.keys(facts), photoCount: photos?.length ?? 0 }, 'social.task_inputs');
    return { [PRODUCT_FACTS_KEY]: facts, [PRODUCT_PHOTOS_KEY]: photos ?? [] };
  };
}
