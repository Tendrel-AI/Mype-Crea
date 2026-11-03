/**
 * name-agent handler (KAN-31) with a fake IAgentLlm: five text artifacts with
 * rationale, input versions and generation metadata; the prompt carries the
 * language rule and no availability claim; bad output and typed provider
 * errors become a failed result. No real model is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { NAME_PROMPT_VERSION, NAME_SYSTEM_PROMPT, handler } from '../handler';
import { setAgentLlm, resetAgentLlm, type AgentCompletionRequest } from '../../../src/services/llm/agent-completion';
import type { A2AMessage } from '../../../src/core/agent-types';
import { TaskError } from '../../../src/core/task-errors';

const TASK = '11111111-1111-1111-1111-111111111111' as A2AMessage['taskId'];
const TENANT = '22222222-2222-2222-2222-222222222222';

function message(requirements: Record<string, unknown>, iteration?: A2AMessage['iteration']): A2AMessage {
  return {
    taskId: TASK,
    tenantId: TENANT,
    agentId: 'name-agent',
    agentCardVersion: '0.1.0',
    requirements,
    ...(iteration ? { iteration } : {}),
    createdAt: new Date().toISOString(),
  };
}

const CANDIDATES = [
  { name: 'Dulce Andino', rationale: 'Une lo dulce del producto con su origen andino.' },
  { name: 'Aguaymanto & Co.', rationale: 'Destaca la fruta principal con un toque moderno.' },
  { name: 'Sabor de Altura', rationale: 'Evoca los Andes y la calidad del producto.' },
  { name: 'Mermeladas Killa', rationale: 'Killa significa luna en quechua y suena cercano.' },
  { name: 'Frutos del Valle', rationale: 'Habla del origen natural de los ingredientes.' },
];

function fakeLlm(candidates: unknown) {
  const calls: AgentCompletionRequest[] = [];
  setAgentLlm({
    complete: vi.fn(async (request: AgentCompletionRequest) => {
      calls.push(request);
      return {
        provider: 'openrouter' as const,
        model: 'fake/naming-1',
        completion: {
          id: 'cmpl-1',
          choices: [{
            message: {
              role: 'assistant' as const,
              content: null,
              tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'propose_business_names', arguments: JSON.stringify({ candidates }) } }],
            },
            finish_reason: 'tool_calls',
          }],
        },
      };
    }),
  });
  return calls;
}

const BRIEF = { business_category: 'alimentos', style_keywords: 'rústico, cálido', product_name: 'Mermelada de aguaymanto' };

describe('name-agent handler', () => {
  afterEach(() => resetAgentLlm());

  it('returns five text candidates with rationale, input versions and generation metadata', async () => {
    const calls = fakeLlm(CANDIDATES);
    const result = await handler(message(BRIEF), undefined);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.map((a) => a.inline)).toEqual(CANDIDATES.map((c) => c.name));
    expect(result.artifacts.every((a) => a.kind === 'text')).toBe(true);
    const sha = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
    expect(result.artifacts[3].metadata).toMatchObject({
      purpose: 'business_name',
      rationale: CANDIDATES[3].rationale,
      candidateIndex: 4,
      candidateCount: 5,
      agentCardVersion: '0.1.0',
      promptVersion: NAME_PROMPT_VERSION,
      provider: 'openrouter',
      model: 'fake/naming-1',
      inputs: {
        business_category: { value: 'alimentos', version: sha('alimentos') },
        style_keywords: { value: 'rústico, cálido', version: sha('rústico, cálido') },
        product_name: { value: 'Mermelada de aguaymanto', version: sha('Mermelada de aguaymanto') },
      },
    });
    expect(typeof result.artifacts[0].metadata?.generatedAt).toBe('string');

    // One usage-gated call, charged to this task, with the forced tool.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: 'naming',
      promptVersion: NAME_PROMPT_VERSION,
      usage: { tenantId: TENANT, agentTaskId: TASK },
      request: { tool_choice: { type: 'function', function: { name: 'propose_business_names' } } },
    });
    const [system, user] = calls[0].request.messages;
    expect(system.content).toBe(NAME_SYSTEM_PROMPT);
    expect(user.content).toContain('- Rubro: "alimentos"');
    expect(user.content).toContain('- Producto: "Mermelada de aguaymanto"');
  });

  it('states the language rule and forbids availability claims in the prompt', () => {
    expect(NAME_SYSTEM_PROMPT.toLowerCase()).toContain('usa español neutro latinoamericano, trata al usuario de tú, nunca voseo');
    expect(NAME_SYSTEM_PROMPT).toContain('No digas que un nombre está disponible, libre, registrado o protegido, ni que es único.');
  });

  it('adds «Iterar» observations as quoted notes, and omits an empty optional field', async () => {
    const calls = fakeLlm(CANDIDATES);
    await handler(
      message({ business_category: 'cosmética', style_keywords: 'natural' }, { parentTaskId: TASK, observations: ['más cortos, sin "inglés"'] }),
      undefined,
    );
    const user = calls[0].request.messages[1].content;
    expect(user).toContain(`Ajustes pedidos sobre la propuesta anterior: "más cortos, sin 'inglés'".`);
    expect(user).not.toContain('Producto');
  });

  it('dedupes names case-insensitively and keeps the first five', async () => {
    fakeLlm([CANDIDATES[0], { name: 'dulce andino', rationale: 'Repetido.' }, ...CANDIDATES.slice(1), { name: 'Extra', rationale: 'Sobra.' }]);
    const result = await handler(message(BRIEF), undefined);
    expect(result.status === 'completed' && result.artifacts.map((a) => a.inline)).toEqual(CANDIDATES.map((c) => c.name));
  });

  it.each([
    ['fewer than five valid candidates', CANDIDATES.slice(0, 4)],
    ['a candidate without rationale', [...CANDIDATES.slice(0, 4), { name: 'Sin razón', rationale: ' ' }]],
    ['no candidates array', 'not-an-array'],
  ])('fails as invalid_output on %s', async (_label, candidates) => {
    fakeLlm(candidates);
    const result = await handler(message(BRIEF), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_output' } });
  });

  it('keeps a typed error from the LLM service (usage limit) as the failure kind', async () => {
    setAgentLlm({ complete: vi.fn(async () => { throw new TaskError('usage_limited', 'Límite alcanzado.'); }) });
    const result = await handler(message(BRIEF), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'usage_limited' } });
  });
});
