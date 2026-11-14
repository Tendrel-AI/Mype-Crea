import { describe, expect, it } from 'vitest';
import { PERSONAS } from '../personas';
import { runConversation, type UserModel } from '../simulate';
import { formatSummary, runCostUsd } from '../report';
import type { ILLMProvider, ModelPurpose } from '../../../src/services/llm/types';

/** Extractor fills every asked field; Responder returns fixed text. Usage differs per purpose. */
const fakeProvider: ILLMProvider = {
  resolve: (purpose: ModelPurpose) => ({
    purpose,
    modelId: `fake-${purpose}`,
    provider: 'openrouter',
    client: {
      chat: {
        completions: {
          create: async (params: { tools?: Array<{ function: { parameters: any } }> }) => {
            if (purpose === 'extractor') {
              const names = Object.keys(params.tools?.[0].function.parameters.properties.fields.properties ?? {});
              const fields = Object.fromEntries(names.map((n) => [n, { value: n === 'business_category' ? 'Artesanía' : `valor ${n}`, confidence: 1 }]));
              return {
                id: 'x',
                choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'submit_extracted_fields', arguments: JSON.stringify({ fields, answers_pending: true }) } }] } }],
                usage: { prompt_tokens: 1000, completion_tokens: 50 },
              };
            }
            return { id: 'y', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Listo, revisa el panel.' } }], usage: { prompt_tokens: 2000, completion_tokens: 80 } };
          },
        },
      },
    },
  }),
} as ILLMProvider;

/** Reads the visible deliverables from the prompt like a user would: change once, then approve. */
function cooperativeUser(): UserModel & { calls: number } {
  const model = {
    calls: 0,
    async complete(_system: string, user: string) {
      model.calls += 1;
      const rows: Array<{ deliverable: string; estado: string; cambio_pedido: boolean }> = JSON.parse(
        user.slice(user.indexOf('Entregables visibles:') + 21).split('\n\n')[0].trim().startsWith('[')
          ? user.slice(user.indexOf('Entregables visibles:') + 21).split('\n\n')[0]
          : '[]',
      );
      const pending = rows.find((r) => r.estado === 'in_review');
      const text = !pending
        ? { action: 'message', text: 'Vendo jabones artesanales.' }
        : pending.cambio_pedido
          ? { action: 'approve', deliverable: pending.deliverable }
          : { action: 'iterate', deliverable: pending.deliverable, observation: 'Más cálido, por favor.' };
      return { text: JSON.stringify(text), input_tokens: 10, output_tokens: 5, latency_ms: 1 };
    },
  };
  return model;
}

describe('simulate conversations', () => {
  it('ends when name, tagline and logo are approved; iterate goes through commands, tokens are recorded', async () => {
    const user = cooperativeUser();
    const run = await runConversation({ persona: PERSONAS.directo, userModel: user, provider: fakeProvider, maxTurns: 10 });

    expect(run.detail).toBeUndefined();
    expect(run.outcome).toBe('completed');
    // One iteration per deliverable, none through the chat.
    const iterations = run.actions.filter((a) => a.action === 'iterate');
    expect(iterations.map((a) => (a as { deliverable: string }).deliverable).sort()).toEqual(['business_name', 'logo', 'tagline']);
    expect(run.dispatches.filter((d) => d.iteration)).toHaveLength(3);
    expect(run.dispatches.filter((d) => !d.iteration)).toHaveLength(3);
    // Extractor and Responder ran once per chat turn only: commands never call them.
    const extractor = run.calls.filter((c) => c.purpose === 'extractor');
    const responder = run.calls.filter((c) => c.purpose === 'responder');
    expect(extractor).toHaveLength(run.chatTurns);
    expect(responder).toHaveLength(run.chatTurns);
    expect(extractor[0]).toMatchObject({ model: 'fake-extractor', provider: 'openrouter', input_tokens: 1000, output_tokens: 50 });
    expect(run.userCalls).toHaveLength(user.calls);
    // Report: cost includes the fixed agent costs on top of the LLM calls.
    expect(runCostUsd(run, 'google/gemini-2.5-flash')).toBeGreaterThan(0.009);
    expect(formatSummary('directo', [run], 'google/gemini-2.5-flash', 'anthropic/claude-haiku-5.5')).toContain('completed=1');
  });

  it('stops a user that never finishes at max-turns', async () => {
    const chatty: UserModel = { complete: async () => ({ text: '{"action":"message","text":"hola"}', input_tokens: 1, output_tokens: 1, latency_ms: 1 }) };
    const run = await runConversation({ persona: PERSONAS['hablador-confuso'], userModel: chatty, provider: fakeProvider, maxTurns: 2 });
    expect(run.outcome).toBe('max_turns');
    expect(run.chatTurns).toBe(2);
  });

  it('ends as protocol_error after two retries of invalid JSON', async () => {
    const broken: UserModel = { complete: async () => ({ text: 'no soy json', input_tokens: 1, output_tokens: 1, latency_ms: 1 }) };
    const run = await runConversation({ persona: PERSONAS.directo, userModel: broken, provider: fakeProvider, maxTurns: 5 });
    expect(run.outcome).toBe('protocol_error');
    expect(run.userCalls).toHaveLength(3);
  });
});
