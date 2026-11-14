/**
 * Logo references (D62), server side: how the brand's reference images reach the logo-agent.
 * Same hook as `socialTaskInputs`: merged into `taskInputsFor` in runtime.ts and recorded in
 * `requirements_snapshot`. A product conversation has none. Server-only.
 */
import type { ConversationId } from '../core/contracts';
import { repos } from '../repos';
import type { Tenant, User } from '../db/with-transaction';
import { loggerFor } from '../services/logger';
import { LOGO_AGENT_ID, LOGO_REFERENCES_KEY, type LogoReferenceRef } from './refs';

const log = loggerFor('logo.task-inputs');

/** The brand's reference images (oldest first), or null when the conversation is not a brand conversation. */
export async function logoReferencesOfConversation(
  tenant: Tenant,
  user: User,
  conversationId: ConversationId,
): Promise<ReadonlyArray<LogoReferenceRef> | null> {
  const owned = repos(tenant, user);
  const context = await owned.conversations.context(conversationId);
  if (!context?.brandId || context.productId) return null;
  const files = await owned.brandFiles.listByBrand(context.brandId);
  return files
    .filter((f) => f.kind === 'logo_reference')
    .map((f) => ({ fileId: f.id, storageKey: f.storageKey, contentType: f.contentType, originalName: f.originalName }));
}

/** The task inputs of one owner's conversations (a `DeliverableCommandContext.taskInputs`). */
export function logoTaskInputs(tenant: Tenant, user: User) {
  return async (conversationId: ConversationId, agentId: string): Promise<Record<string, unknown>> => {
    if (agentId !== LOGO_AGENT_ID) return {};
    const references = await logoReferencesOfConversation(tenant, user, conversationId);
    if (!references?.length) return {};
    log.debug({ conversationId, referenceCount: references.length }, 'logo.task_inputs');
    return { [LOGO_REFERENCES_KEY]: references };
  };
}
