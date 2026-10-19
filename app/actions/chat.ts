'use server';

import { resolveIdentity } from '../../src/auth/resolve-identity';
import { repos } from '../../src/repos';
import {
  getChatInputAdapter,
  getChatOutputAdapter,
  getOrchestrator,
} from '../../src/core/orchestrator/runtime';
import type { ConversationId } from '../../src/core/contracts';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('controller.chat');

export interface ChatActionResult {
  readonly content: string;
}

/**
 * Drives one user turn through the four-stage orchestrator pipeline:
 *   Extractor (ChatInputAdapter) -> Merge -> Planner -> Responder (ChatOutputAdapter)
 *
 * The Responder produces Spanish prose only; it never emits tool calls and
 * never generates names, images, or HTML. Deliverables are produced by
 * sub-agents dispatched by the orchestrator core (see
 * docs/agents/architecture.md §2.1, §2.3).
 */
export async function chatAction(params: {
  conversationId: string;
  userMessage: string;
}): Promise<ChatActionResult> {
  const conversationId = params.conversationId as ConversationId;
  const userMessage = params.userMessage.trim();
  if (userMessage.length === 0) {
    return { content: '' };
  }

  const { tenant, user } = await resolveIdentity();
  const child = log.child({
    tenantId: tenant.id,
    userId: user.id,
    conversationId,
  });
  child.info('chatAction.start');

  const r = repos(tenant, user);
  const orchestrator = getOrchestrator();
  const inputAdapter = getChatInputAdapter();
  const outputAdapter = getChatOutputAdapter();

  // Ensure conversation row + register the actor with the orchestrator's
  // in-memory tenant map. Both calls are idempotent.
  await r.conversations.getOrCreate(conversationId, []);
  await orchestrator.startConversation(conversationId, tenant.id, user.id);

  // Capture the prior plan (what the Responder rendered last turn) so the
  // Extractor's affirmation/denial fast-path can short-circuit when the user
  // confirms a `confirm_field` decision with "sí". A confirm_field is always
  // emitted solo by the planner, so when present it's the only plan entry.
  const priorPlan = await orchestrator.getNextDecision(conversationId);
  const priorConfirm = priorPlan.find((d) => d.kind === 'confirm_field');

  const llmContext = {
    tenant,
    user,
    conversationId,
    promptVersion: 'chatAction.v1',
  };

  // 1) Extract.
  const delta = await inputAdapter.extract({
    conversationId,
    userMessage,
    priorDecision: priorConfirm,
    llmContext,
  });

  // 2) Persist the user message before applying the delta — the orchestrator
  // may dispatch synchronously and we want the message row to exist by the
  // time downstream consumers read history.
  await r.messages.insert({
    conversationId,
    role: 'user',
    content: userMessage,
  });

  // 3) Merge + plan + dispatch.
  await orchestrator.applyDelta(delta);

  // 4) Render the next plan in Spanish.
  const decisions = await orchestrator.getNextDecision(conversationId);
  const snapshot = await orchestrator.getSnapshot(conversationId);
  const recent = await r.messages.listByConversation(conversationId, { limit: 10 });

  const { content } = await outputAdapter.render({
    decisions,
    recentMessages: recent,
    snapshot,
    llmContext,
  });

  if (content.length > 0) {
    await r.messages.insert({
      conversationId,
      role: 'assistant',
      content,
    });
  }

  child.info(
    { contentLength: content.length, decisionKinds: decisions.map((d) => d.kind) },
    'chatAction.complete',
  );

  return { content };
}
