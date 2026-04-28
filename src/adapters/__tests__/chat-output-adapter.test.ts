/**
 * Unit tests for ChatOutputAdapter. One case per PlannerDecision kind.
 *
 * The adapter calls Gemini Pro through the LLM provider; we inject a fake
 * provider that captures the prompt and returns scripted Spanish content.
 * Mocks the repos factory so withLlmLogging never touches the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordSpy = vi.fn(async () => 'fake-llm-call-id');
vi.mock('../../repos', () => ({
  repos: () => ({ llmCalls: { record: recordSpy } }),
  systemRepos: () => ({ llmCalls: { record: recordSpy } }),
}));

import { ChatOutputAdapter } from '../chat-output-adapter';
import { buildDefaultRegistry } from '../../core/orchestrator/bootstrap-registry';
import { resetProvider, setProvider } from '../../services/llm';
import type { ConversationSnapshot, PlannerDecision } from '../../core/contracts';

const conversationId = '00000000-0000-0000-0000-000000000003';
const tenantId = '00000000-0000-0000-0000-000000000001';

const ctx = {
  tenant: { id: tenantId },
  user: { id: '00000000-0000-0000-0000-000000000002' },
  conversationId,
  promptVersion: 'responder.chat-step1.v1',
};

const emptySnapshot: ConversationSnapshot = {
  conversationId,
  tenantId,
  agentStates: {
    'name-agent': {
      requiredFields: {},
      optionalFields: {},
      iterationCount: 0,
    },
  },
  updatedAt: new Date().toISOString(),
};

const filledSnapshot: ConversationSnapshot = {
  conversationId,
  tenantId,
  agentStates: {
    'name-agent': {
      requiredFields: {
        business_name: { status: 'filled', value: 'Café Andino', confidence: 1 },
        business_profile: {
          status: 'filled',
          value: 'café orgánico de Cajamarca',
          confidence: 1,
        },
      },
      optionalFields: {},
      iterationCount: 1,
    },
  },
  updatedAt: new Date().toISOString(),
};

interface CapturedCall {
  systemPrompt: string;
  messageCount: number;
}

function fakeProvider(scriptedReply: string, captured: CapturedCall[]) {
  return {
    resolve: () => ({
      purpose: 'responder' as const,
      modelId: 'google/gemini-2.5-pro',
      client: {
        chat: {
          completions: {
            create: vi.fn(async (params: any) => {
              const sys = params.messages.find((m: any) => m.role === 'system')?.content ?? '';
              captured.push({ systemPrompt: sys, messageCount: params.messages.length });
              return {
                id: 'chatcmpl-fake',
                choices: [{ message: { role: 'assistant', content: scriptedReply } }],
                usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
              };
            }),
          },
        },
      } as any,
    }),
  };
}

describe('ChatOutputAdapter', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });
  afterEach(() => {
    resetProvider();
  });

  it('renders request_field with the field name in the prompt', async () => {
    const captured: CapturedCall[] = [];
    setProvider(fakeProvider('Cuéntame el nombre que has pensado para tu negocio.', captured));
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = {
      kind: 'request_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
      promptHint: '¿Cómo se llama tu negocio?',
    };
    const { content } = await adapter.render({
      decision,
      recentMessages: [{ role: 'user', content: 'hola' }],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content).toContain('nombre');
    expect(captured[0].systemPrompt).toContain('business_name');
    expect(captured[0].systemPrompt).toContain('request_field');
  });

  it('renders confirm_field with the pending value in the prompt', async () => {
    const captured: CapturedCall[] = [];
    setProvider(fakeProvider('¿Confirmas que tu negocio se llama "Café Andino"?', captured));
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = {
      kind: 'confirm_field',
      agentId: 'name-agent',
      fieldName: 'business_name',
      pendingValue: 'Café Andino',
      reason: 'low_confidence',
    };
    const { content } = await adapter.render({
      decision,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content).toContain('Café Andino');
    expect(captured[0].systemPrompt).toContain('Café Andino');
    expect(captured[0].systemPrompt).toContain('confirm_field');
  });

  it('renders announce_dispatch with a holding-message prompt', async () => {
    const captured: CapturedCall[] = [];
    setProvider(fakeProvider('Estoy guardando tu información, dame un momento.', captured));
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = {
      kind: 'announce_dispatch',
      agentId: 'name-agent',
      taskId: '11111111-1111-1111-1111-111111111111',
    };
    const { content } = await adapter.render({
      decision,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content.length).toBeGreaterThan(0);
    expect(captured[0].systemPrompt).toContain('announce_dispatch');
  });

  it('renders announce_completion with the captured fields summarized', async () => {
    const captured: CapturedCall[] = [];
    setProvider(
      fakeProvider(
        '¡Listo! Tu negocio "Café Andino" ya tiene su perfil. Sigamos con el logo.',
        captured,
      ),
    );
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = {
      kind: 'announce_completion',
      agentId: 'name-agent',
      taskId: '11111111-1111-1111-1111-111111111111',
      deliverableIds: [],
    };
    const { content } = await adapter.render({
      decision,
      recentMessages: [],
      snapshot: filledSnapshot,
      llmContext: ctx,
    });

    expect(content).toContain('Café Andino');
    // The system prompt should include the filled fields so the responder
    // can summarize them.
    expect(captured[0].systemPrompt).toContain('business_name');
    expect(captured[0].systemPrompt).toContain('Café Andino');
  });

  it('renders idle: awaiting_user as an open invitation', async () => {
    const captured: CapturedCall[] = [];
    setProvider(fakeProvider('¿Sobre qué te gustaría hablar?', captured));
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = { kind: 'idle', reason: 'awaiting_user' };
    const { content } = await adapter.render({
      decision,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content.length).toBeGreaterThan(0);
    expect(captured[0].systemPrompt).toContain('awaiting_user');
  });

  it('renders idle: all_complete as a step-finished message', async () => {
    const captured: CapturedCall[] = [];
    setProvider(fakeProvider('Hemos terminado este paso, sigamos.', captured));
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = { kind: 'idle', reason: 'all_complete' };
    const { content } = await adapter.render({
      decision,
      recentMessages: [],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    expect(content.length).toBeGreaterThan(0);
    expect(captured[0].systemPrompt).toContain('all_complete');
  });

  it('forwards the last user/assistant turns as conversation context', async () => {
    const captured: CapturedCall[] = [];
    setProvider(fakeProvider('ok', captured));
    const adapter = new ChatOutputAdapter(buildDefaultRegistry());

    const decision: PlannerDecision = { kind: 'idle', reason: 'awaiting_user' };
    await adapter.render({
      decision,
      recentMessages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hola, cuéntame de tu negocio' },
        { role: 'system', content: 'should be filtered out' } as any,
      ],
      snapshot: emptySnapshot,
      llmContext: ctx,
    });

    // 1 system + 2 chat turns; the system row from recentMessages is dropped.
    expect(captured[0].messageCount).toBe(3);
  });
});
