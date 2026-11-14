/**
 * MYPES Platform — Chat output adapter (Layer 4: Responder)
 * ==========================================================
 *
 * Location: src/adapters/chat-output-adapter.ts
 *
 * Consumes a `ReadonlyArray<PlannerDecision>` (the orchestrator's plan for
 * this turn) and produces the user-visible Spanish reply by calling Gemini
 * Pro through the LLM provider abstraction. Text-only output: this adapter
 * never emits tool calls. Tool-driven side effects (image generation, HTML,
 * marketing markdown) live in the legacy chat path used by Pasos 2-5.
 *
 * The plan is an array because a single user turn can bundle multiple
 * decisions, e.g. `[announce_dispatch(logo), request_fields(tagline:
 * business_profile)]`. The Responder always speaks; there is no "idle" turn.
 *
 * Contract conformance: this PR uses an imperative `render()` shape because
 * Next.js server actions are request/response. The `OutputAdapter.onDecision`
 * subscription contract from contracts.ts is intentionally NOT implemented
 * here yet — it'll be added when the controller flow becomes pub/sub.
 */

import type {
  ConversationSnapshot,
  DeliverableCommandKind,
  FieldSlot,
  PlannerDecision,
  UploadRequestEntry,
} from '../core/contracts';
import type { A2AArtifact } from '../core/agent-types';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import type { MessageRow } from '../repos/models';
import { getProvider } from '../services/llm';
import {
  assertResolvedModelPurpose,
  RESPONDER_FRAGMENT_FALLBACKS,
  type AdapterExecution,
} from '../services/ai-config/adapter-behavior';
import { resolveAdapterBehavior } from '../services/prompts/adapter-behavior';
import type { PromptVersions } from '../services/prompts';
import { withLlmLogging, type LlmLoggingContext } from '../services/llm-logger';
import { loggerFor } from '../services/logger';
import type { ChatContext } from './chat-welcome';
import { UNNAMED_BRAND_LABEL, UNNAMED_PRODUCT_LABEL } from '../conversations/label';

const log = loggerFor('adapter.chat-output');

/** Longest legit reply is an announce_completion list of ~5 name/tagline options (~1.3k chars); 2000 leaves margin, runaway output is far longer. */
export const MAX_REPLY_CHARS = 2000;
export const GENERIC_FALLBACK_REPLY = 'Revisa el panel para ver tus opciones o cuéntame más sobre tu negocio.';
export type UnusableReplyReason = 'empty' | 'special_tokens' | 'prompt_leak' | 'too_long';

export const SPECIAL_TOKENS = /<[｜|][^>]{0,40}[｜|]>/;
const PROMPT_MARKERS = ['kind=', 'Acción obligatoria', 'Decisión:'];

/** Pure check for model output that must never reach the user (empty, garbage, leaked prompt, runaway). */
export function unusableReplyReason(content: string): UnusableReplyReason | undefined {
  if (content.trim().length === 0) return 'empty';
  if (SPECIAL_TOKENS.test(content)) return 'special_tokens';
  if (PROMPT_MARKERS.some((m) => content.includes(m))) return 'prompt_leak';
  if (content.length > MAX_REPLY_CHARS) return 'too_long';
  return undefined;
}

function fallbackReply(decisions: ReadonlyArray<PlannerDecision>): string {
  for (const d of decisions) if (d.kind === 'request_fields' && d.fields.length > 0) return d.fields[0].promptHint;
  return GENERIC_FALLBACK_REPLY;
}

export interface RenderInput {
  readonly decisions: ReadonlyArray<PlannerDecision>;
  readonly recentMessages: ReadonlyArray<Pick<MessageRow, 'role' | 'content'>>;
  readonly snapshot: ConversationSnapshot;
  readonly llmContext: LlmLoggingContext;
  /** Explicit frozen execution for product turns; omitted by legacy/eval callers. */
  readonly execution?: AdapterExecution;
  /** The conversation's pinned prompt versions (D22); omitted = the active versions. */
  readonly promptVersions?: PromptVersions;
  /** KAN-93: brand/product names of the conversation; null/omitted = legacy conversation or unknown. */
  readonly context?: ChatContext | null;
}

export class ChatOutputAdapter {
  constructor(private readonly registry: AgentRegistry) {}

  async render(input: RenderInput): Promise<{ content: string; fallback?: UnusableReplyReason }> {
    const { decisions, recentMessages, snapshot, llmContext, execution, promptVersions, context } = input;
    const behavior = resolveAdapterBehavior('responder', promptVersions, [], execution);
    if (execution) assertResolvedModelPurpose(execution.model, 'responder');
    const child = log.child({
      op: 'render',
      conversationId: snapshot.conversationId,
      tenantId: snapshot.tenantId,
      decisionKinds: decisions.map((d) => d.kind),
    });

    const systemPrompt = buildResponderSystemPrompt(
      decisions,
      snapshot,
      this.registry,
      behavior.responder.promptTemplate,
      behavior.responder.promptFragments,
      context,
    );
    const recent = (behavior.responder.historyLimit === 0
      ? []
      : recentMessages.slice(-behavior.responder.historyLimit))
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    child.info(
      {
        contract: 'PlannerDecision[]',
        decisions,
        recentMessagesCount: recent.length,
        snapshotAgentsCount: Object.keys(snapshot.agentStates).length,
      },
      'responder.input',
    );

    const resolved = execution?.model ?? getProvider().resolve('responder');
    child.info({ model: resolved.modelId }, 'responder.llm.start');

    const completion = await withLlmLogging(
      resolved.client,
      {
        model: resolved.modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...recent],
        temperature: behavior.responder.temperature,
        max_tokens: behavior.responder.maxTokens,
      },
      { ...llmContext, promptVersion: behavior.responder.promptVersion, modelRevision: resolved.modelRevision, provider: resolved.provider ?? 'openrouter', purpose: 'responder' },
    );

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const fallback = unusableReplyReason(raw);
    if (fallback) child.warn({ reason: fallback, contentLength: raw.length }, 'responder.fallback');
    const content = fallback ? fallbackReply(decisions) : raw;
    child.info(
      {
        contractOut: 'AssistantMessage',
        contentLength: content.length,
        contentPreview: content.length > 120 ? `${content.slice(0, 117)}...` : content,
      },
      'responder.output',
    );
    return fallback ? { content, fallback } : { content };
  }
}

function buildResponderSystemPrompt(
  decisions: ReadonlyArray<PlannerDecision>,
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
  template: string,
  frozenFragments: Readonly<Record<string, string>>,
  context?: ChatContext | null,
): string {
  // Releases frozen before responder v6 lack the KAN-28 command fragments.
  const fragments = { ...RESPONDER_FRAGMENT_FALLBACKS, ...frozenFragments };
  const statusSummary = describeFieldStatus(snapshot);
  const decisionsBlock = [contextLine(context, fragments), describeDecisions(decisions, registry, fragments, snapshot)].filter(Boolean).join('\n\n');
  // Templates from v15 place the per-turn dispatch guardrail after the state (`{{dispatchGuardrail}}`),
  // keeping `{{guardrails}}` static; older frozen templates keep it inside the guardrails.
  const lateDispatch = template.includes('{{dispatchGuardrail}}');
  const guardrails = buildGuardrails(decisions, fragments, !lateDispatch);
  const dispatchGuardrail = lateDispatch && needsDispatchGuardrail(decisions)
    ? `\n${fragments.dispatchRequestGuardrail}`
    : '';

  return template
    .replaceAll('{{persona}}', fragments.personaContextual)
    .replaceAll('{{stateHeading}}', fragments.systemHeading)
    .replaceAll('{{decisionsBlock}}', decisionsBlock)
    .replaceAll(
      '{{progressBlock}}',
      statusSummary ? `\n${fragments.progressHeading}\n${statusSummary}` : '',
    )
    .replaceAll('{{guardrails}}', guardrails)
    .replaceAll('{{dispatchGuardrail}}', dispatchGuardrail);
}

/** KAN-93: «chat de la marca X» / «chat del producto Y de la marca X»; none for a legacy conversation. */
function contextLine(context: ChatContext | null | undefined, fragments: Readonly<Record<string, string>>): string {
  if (!context?.brandId) return '';
  const brandName = context.brandName?.trim() || UNNAMED_BRAND_LABEL;
  if (!context.productId) return applyPromptTemplate(fragments.brandChatContext, { brandName });
  return applyPromptTemplate(fragments.productChatContext, { brandName, productName: context.productName?.trim() || UNNAMED_PRODUCT_LABEL });
}

function describeDecisions(
  decisions: ReadonlyArray<PlannerDecision>,
  registry: AgentRegistry,
  fragments: Readonly<Record<string, string>>,
  snapshot: ConversationSnapshot,
): string {
  if (decisions.length === 0) {
    // Should not happen — the planner always returns at least one decision —
    // but degrade gracefully rather than send an empty prompt.
    return fragments.noopDecision;
  }

  if (decisions.length === 1) {
    return describeDecision(decisions[0], registry, fragments, snapshot);
  }

  return decisions
    .map((d, i) => `Decisión ${i + 1}:\n${describeDecision(d, registry, fragments, snapshot)}`)
    .join('\n\n');
}

function describeUpload(
  kindTag: string,
  u: UploadRequestEntry,
  registry: AgentRegistry,
  fragments: Readonly<Record<string, string>>,
): string {
  return applyPromptTemplate(fragments.requestUploadDecision, {
    kind: kindTag, agentId: u.agentId, deliverableLabel: deliverableLabelFor(u.agentId, u.deliverableKind, registry),
    uploadKind: u.uploadKind, promptHint: u.promptHint,
  });
}

function describeDecision(
  decision: PlannerDecision,
  registry: AgentRegistry,
  fragments: Readonly<Record<string, string>>,
  snapshot: ConversationSnapshot,
): string {
  // Each block leads with `kind=...` as a machine-readable tag so the
  // responder can ground on the literal decision name from PlannerDecision,
  // and so log audits / tests can match on the kind verbatim.
  const kindTag = `kind=${decision.kind}`;
  switch (decision.kind) {
    case 'request_fields': {
      const lines = decision.fields.map(
        (f, i) =>
          `  ${i + 1}. ${f.fieldName}${f.previousValue !== undefined ? ' (el usuario lo había dado y lo reseteó)' : ''}: "${f.promptHint}"`,
      );
      const single = decision.fields.length === 1;
      void registry;
      const uploadBlocks = (decision.uploads ?? []).map((u) => describeUpload(kindTag, u, registry, fragments));
      const fieldsBlock = applyPromptTemplate(fragments.requestFieldsDecision, {
        kind: kindTag,
        fieldCountDescription: single ? 'UN campo' : `${decision.fields.length} campos`,
        agentId: decision.agentId,
        fieldLines: lines.join('\n'),
        actionLine: single
          ? fragments.requestFieldsSingleAction
          : decision.fields.length > 2 ? fragments.requestFieldsListAction : fragments.requestFieldsMultiAction,
      });
      // KAN-110: the upload ask is composed from the existing fragment so both go in one reply.
      return [fieldsBlock, ...uploadBlocks.map((b) => `Además, en el mismo mensaje:\n${b}`)].join('\n\n');
    }
    case 'confirm_fields':
      return applyPromptTemplate(fragments.confirmFieldsDecision, {
        kind: kindTag,
        entryLines: decision.entries.map((e) => `  - ${e.fieldName}: "${String(e.pendingValue)}"`).join('\n'),
        reason: decision.reason,
      });
    case 'request_selection':
      return applyPromptTemplate(fragments.requestSelectionDecision, {
        kind: kindTag, agentId: decision.agentId, count: String(decision.candidateDeliverableIds.length),
      });
    case 'offer_generation':
      return applyPromptTemplate(fragments.offerGenerationDecision, {
        kind: kindTag,
        agentId: decision.agentId,
        deliverableLabel: deliverableLabelFor(decision.agentId, decision.deliverableKind, registry),
      });
    case 'request_upload':
      return describeUpload(kindTag, decision, registry, fragments);
    case 'announce_dispatch':
      return applyPromptTemplate(fragments.announceDispatchDecision, {
        kind: kindTag, agentId: decision.agentId,
      });
    case 'announce_completion':
      return describeAnnounceCompletion(kindTag, decision.agentId, decision.artifacts, fragments);
    case 'report_deliverable_status': {
      const template = {
        in_review: fragments.reportStatusInReviewDecision,
        failed: fragments.reportStatusFailedDecision,
        generating: fragments.reportStatusGeneratingDecision,
      }[decision.state];
      return applyPromptTemplate(template, {
        kind: kindTag,
        agentId: decision.agentId,
        deliverableLabel: deliverableLabelFor(decision.agentId, decision.deliverableKind, registry),
        commandsLine: decision.allowedCommands.map((c) => COMMAND_BUTTON_LABELS[c]).join(', ') || 'ninguno',
      });
    }
    case 'exhausted':
      return applyPromptTemplate(fragments.exhaustedDecision, {
        kind: kindTag,
        scope: decision.scope,
        limit: String(decision.limit),
        used: String(decision.used),
        deliverableLabel: decision.agentId ? deliverableLabelFor(decision.agentId, decision.deliverableKind ?? decision.agentId, registry) : '',
      });
    case 'announce_all_complete':
      return applyPromptTemplate(
        snapshot.links?.hasProduct === true ? fragments.announceAllCompleteProductDecision : fragments.announceAllCompleteBrandDecision,
        { kind: kindTag },
      );
  }
}

/**
 * Tone guardrails. The base set is constant; we add an extra line when the
 * plan bundles `announce_dispatch` with a follow-on `request_fields` so the
 * Responder writes a single bridged sentence ("ya empezó X — para Y, …")
 * instead of two separate replies.
 */
function buildGuardrails(
  decisions: ReadonlyArray<PlannerDecision>,
  fragments: Readonly<Record<string, string>>,
  includeDispatch: boolean,
): string {
  const lines = [fragments.guardrails];
  if (includeDispatch && needsDispatchGuardrail(decisions)) lines.push(fragments.dispatchRequestGuardrail);
  // KAN-28: chat never starts, changes or approves a deliverable.
  lines.push(fragments.commandGuidanceGuardrail);
  // KAN-91: never end on a question the system cannot act on.
  lines.push(fragments.noDeadEndGuardrail);
  return lines.join('\n');
}

function needsDispatchGuardrail(decisions: ReadonlyArray<PlannerDecision>): boolean {
  return decisions.some((d) => d.kind === 'announce_dispatch') && decisions.some((d) => d.kind === 'request_fields');
}

/** Spanish panel button names (see components/crea-mype/DeliverableCommands.tsx). */
export const COMMAND_BUTTON_LABELS: Readonly<Record<DeliverableCommandKind, string>> = {
  generate: 'Generar',
  iterate: 'Iterar',
  approve: 'Aprobar',
  retry: 'Reintentar',
  cancel: 'Cancelar',
  use_own: 'Usar mi …',
};

/** Human label for a deliverable: the Agent Card's tab label, else its kind. */
export function deliverableLabelFor(agentId: string, deliverableKind: string, registry: AgentRegistry): string {
  try {
    return registry.get(agentId).card['mypes:ui']?.tabLabel ?? deliverableKind;
  } catch {
    return deliverableKind;
  }
}

/**
 * Build the announce_completion block. Branches on artifact kind:
 *  - text artifacts (`kind === 'text'` with string `inline`): list them
 *    literally so the Responder can present them in the chat reply. This is
 *    the channel through which name/tagline/label suggestions reach the user.
 *  - image/visual artifacts: keep the existing "look at the side panel"
 *    template — the SSE stream already pushed the URL to the UI.
 *  - mixed: image template wins, with a hint to confirm.
 */
function describeAnnounceCompletion(
  kindTag: string,
  agentId: string,
  artifacts: ReadonlyArray<A2AArtifact>,
  fragments: Readonly<Record<string, string>>,
): string {
  const textOptions = artifacts
    .filter((a) => a.kind === 'text' && typeof a.inline === 'string')
    .map((a) => String(a.inline));
  const hasVisual = artifacts.some((a) => a.kind !== 'text');

  if (textOptions.length > 0 && !hasVisual) {
    const numbered = textOptions
      .map((text, i) => `  ${i + 1}. ${text}`)
      .join('\n');
    return applyPromptTemplate(fragments.announceCompletionTextDecision, {
      kind: kindTag, agentId, numberedOptions: numbered, count: String(textOptions.length),
    });
  }

  if (hasVisual) {
    return applyPromptTemplate(fragments.announceCompletionVisualDecision, { kind: kindTag, agentId });
  }

  // No artifacts at all — degrade to a minimal completion message.
  return applyPromptTemplate(fragments.announceCompletionEmptyNoNextDecision, { kind: kindTag, agentId });
}

function applyPromptTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (rendered, [key, value]) => rendered.replaceAll(`{{${key}}}`, value),
    template,
  );
}

/**
 * Status-only summary: filled / pending / empty per field, never the value.
 * Values reach the responder only through the decision block (confirm_fields'
 * `pendingValue`s), which is the one place value paraphrase is expected.
 */
function describeFieldStatus(snapshot: ConversationSnapshot): string {
  const lines: string[] = [];
  for (const [agentId, agentState] of Object.entries(snapshot.agentStates)) {
    for (const [fieldName, slot] of Object.entries(agentState.requiredFields) as Array<
      [string, FieldSlot]
    >) {
      lines.push(`- ${agentId}.${fieldName} (requerido): ${slot.status}`);
    }
    for (const [fieldName, slot] of Object.entries(agentState.optionalFields) as Array<
      [string, FieldSlot]
    >) {
      lines.push(`- ${agentId}.${fieldName} (opcional): ${slot.status}`);
    }
  }
  return lines.join('\n');
}
