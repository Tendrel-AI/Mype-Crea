'use server';

import { authorizeConversation, isUuid } from './conversation-access';
import { repos } from '../../src/repos';
import type { ConversationId } from '../../src/core/contracts';
import { clientDeliverableUrl } from '../../src/core/deliverable-url';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.brand-assets');

export type BrandAssetsResult =
  | {
      readonly ok: true;
      readonly brandId: string | null;
      readonly logoUrl: string | null;
      readonly name: string | null;
      readonly tagline: string | null;
      /** Newest brand-level conversation among the owner's recent ones (null when none is listed). */
      readonly brandConversationId: string | null;
    }
  | { readonly ok: false; readonly message: string };

const UNAVAILABLE = 'No pudimos cargar los recursos de tu marca.';

/**
 * D34: the brand's approved logo, name and tagline (made in the brand chat) for a product conversation,
 * read-only. Owner-only: the conversation is authorized first and every read goes through the owner's repos.
 */
export async function loadBrandAssetsAction(input: { readonly conversationId: string }): Promise<BrandAssetsResult> {
  if (!isUuid(input?.conversationId)) return { ok: false, message: UNAVAILABLE };
  const conversationId = input.conversationId as ConversationId;
  const authorized = await authorizeConversation(conversationId, { requireDurability: false, requireTerms: false });
  if (!authorized.ok) return { ok: false, message: authorized.message };
  try {
    const { tenant, user } = authorized.identity;
    const owned = repos(tenant, user);
    const context = await owned.conversations.context(conversationId);
    if (!context?.brandId) return { ok: true, brandId: null, logoUrl: null, name: null, tagline: null, brandConversationId: null };
    const [approved, recent] = await Promise.all([owned.deliverables.listBrandApprovedElsewhere(conversationId), owned.conversations.listRecent()]);
    const of = (kind: string) => approved.find((row) => row.kind === kind);
    const text = (kind: string) => {
      const value = of(kind)?.contentInline?.value;
      return typeof value === 'string' && value.trim() ? value : null;
    };
    const logo = of('logo');
    return {
      ok: true,
      brandId: context.brandId,
      logoUrl: logo ? clientDeliverableUrl({ ...logo, metadata: logo.artifactMetadata ?? logo.contentInline?.metadata }) : null,
      name: text('business_name'),
      tagline: text('tagline'),
      brandConversationId: recent.find((row) => row.brandId === context.brandId && row.productId === null)?.conversationId ?? null,
    };
  } catch (error) {
    log.error({ conversationId, err: error }, 'brandAssets.failed');
    return { ok: false, message: UNAVAILABLE };
  }
}
