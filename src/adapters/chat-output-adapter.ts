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
  FieldSlot,
  PlannerDecision,
} from '../core/contracts';
import type { A2AArtifact } from '../core/agent-types';
import type { AgentRegistry } from '../core/orchestrator/agent-registry';
import type { MessageRow } from '../repos/models';
import { getProvider } from '../services/llm';
import {
  assertResolvedModelPurpose,
  assertSupportedAdapterBehavior,
  createCurrentAdapterBehaviorSnapshot,
  type AdapterExecution,
} from '../services/ai-config/adapter-behavior';
import { withLlmLogging, type LlmLoggingContext } from '../services/llm-logger';
import { loggerFor } from '../services/logger';

const log = loggerFor('adapter.chat-output');

export interface RenderInput {
  readonly decisions: ReadonlyArray<PlannerDecision>;
  readonly recentMessages: ReadonlyArray<Pick<MessageRow, 'role' | 'content'>>;
  readonly snapshot: ConversationSnapshot;
  readonly llmContext: LlmLoggingContext;
  /** Explicit frozen execution for product turns; omitted by legacy/eval callers. */
  readonly execution?: AdapterExecution;
}

export class ChatOutputAdapter {
  constructor(private readonly registry: AgentRegistry) {}

  async render(input: RenderInput): Promise<{ content: string }> {
    const { decisions, recentMessages, snapshot, llmContext, execution } = input;
    const behavior = execution?.behavior ?? createCurrentAdapterBehaviorSnapshot();
    assertSupportedAdapterBehavior(behavior, 'responder');
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

    const content = completion.choices[0]?.message?.content?.trim() ?? '';
    if (content.length === 0) {
      child.warn('responder.empty_content');
    }
    child.info(
      {
        contractOut: 'AssistantMessage',
        contentLength: content.length,
        contentPreview: content.length > 120 ? `${content.slice(0, 117)}...` : content,
      },
      'responder.output',
    );
    return { content };
  }
}

function buildResponderSystemPrompt(
  decisions: ReadonlyArray<PlannerDecision>,
  snapshot: ConversationSnapshot,
  registry: AgentRegistry,
  template: string,
  fragments: Readonly<Record<string, string>>,
): string {
  const statusSummary = describeFieldStatus(snapshot);
  const decisionsBlock = describeDecisions(decisions, registry, fragments);
  const guardrails = buildGuardrails(decisions, fragments);

  return template
    .replaceAll('{{persona}}', fragments.persona)
    .replaceAll('{{stateHeading}}', fragments.systemHeading)
    .replaceAll('{{decisionsBlock}}', decisionsBlock)
    .replaceAll(
      '{{progressBlock}}',
      statusSummary ? `\n${fragments.progressHeading}\n${statusSummary}` : '',
    )
    .replaceAll('{{guardrails}}', guardrails);
}

function describeDecisions(
  decisions: ReadonlyArray<PlannerDecision>,
  registry: AgentRegistry,
  fragments: Readonly<Record<string, string>>,
): string {
  if (decisions.length === 0) {
    // Should not happen — the planner always returns at least one decision —
    // but degrade gracefully rather than send an empty prompt.
    return fragments.noopDecision;
  }

  if (decisions.length === 1) {
    return describeDecision(decisions[0], registry, fragments);
  }

  return decisions
    .map((d, i) => `Decisión ${i + 1}:\n${describeDecision(d, registry, fragments)}`)
    .join('\n\n');
}

function describeDecision(
  decision: PlannerDecision,
  registry: AgentRegistry,
  fragments: Readonly<Record<string, string>>,
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
      return applyPromptTemplate(fragments.requestFieldsDecision, {
        kind: kindTag,
        fieldCountDescription: single ? 'UN campo' : `${decision.fields.length} campos`,
        agentId: decision.agentId,
        fieldLines: lines.join('\n'),
        actionLine: single ? fragments.requestFieldsSingleAction : fragments.requestFieldsMultiAction,
      });
    }
    case 'confirm_field':
      return applyPromptTemplate(fragments.confirmFieldDecision, {
        kind: kindTag, agentId: decision.agentId, fieldName: decision.fieldName,
        pendingValue: String(decision.pendingValue), reason: decision.reason,
      });
    case 'request_selection':
      return applyPromptTemplate(fragments.requestSelectionDecision, {
        kind: kindTag, agentId: decision.agentId, count: String(decision.candidateDeliverableIds.length),
      });
    case 'announce_dispatch':
      return applyPromptTemplate(fragments.announceDispatchDecision, {
        kind: kindTag, agentId: decision.agentId,
      });
    case 'announce_completion':
      return describeAnnounceCompletion(kindTag, decision.agentId, decision.artifacts, fragments);
    case 'announce_all_complete':
      return applyPromptTemplate(fragments.announceAllCompleteDecision, { kind: kindTag });
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
): string {
  const hasDispatch = decisions.some((d) => d.kind === 'announce_dispatch');
  const hasRequestFields = decisions.some((d) => d.kind === 'request_fields');
  return hasDispatch && hasRequestFields
    ? `${fragments.guardrails}\n${fragments.dispatchRequestGuardrail}`
    : fragments.guardrails;
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
  return applyPromptTemplate(fragments.announceCompletionEmptyDecision, { kind: kindTag, agentId });
}

function applyPromptTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (rendered, [key, value]) => rendered.replaceAll(`{{${key}}}`, value),
    template,
  );
}

/**
 * Status-only summary: filled / pending / empty per field, never the value.
 * Values reach the responder only through the decision block (confirm_field's
 * `pendingValue`), which is the one place value paraphrase is expected.
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
