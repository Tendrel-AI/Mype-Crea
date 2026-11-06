/**
 * tagline-agent handler (KAN-32) with a fake IAgentLlm: five text artifacts
 * with rationale, built from the APPROVED name (`message.upstream`), whose
 * id and fingerprint are recorded with the other inputs; the prompt carries
 * the language rule and no availability claim; no approved name or bad
 * output fails typed. No real model is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { TAGLINE_PROMPT_VERSION, TAGLINE_SYSTEM_PROMPT, handler } from '../handler';
import taglineCard from '../agent-card.json';
import nameCard from '../../name-agent/agent-card.json';
import { setAgentLlm, resetAgentLlm, type AgentCompletionRequest } from '../../../src/services/llm/agent-completion';
import { recordedFieldVersions } from '../../../src/core/deliverable-inputs';
import type { A2AMessage } from '../../../src/core/agent-types';

const TASK = '11111111-1111-1111-1111-111111111111' as A2AMessage['taskId'];
const TENANT = '22222222-2222-2222-2222-222222222222';
const NAME_ID = '33333333-3333-4333-8333-333333333333';

function message(requirements: Record<string, unknown>, upstream?: A2AMessage['upstream'], iteration?: A2AMessage['iteration']): A2AMessage {
  return {
    taskId: TASK,
    tenantId: TENANT,
    agentId: 'tagline-agent',
    agentCardVersion: '0.1.0',
    requirements,
    ...(upstream ? { upstream } : {}),
    ...(iteration ? { iteration } : {}),
    createdAt: new Date().toISOString(),
  };
}

const CANDIDATES = [
  { tagline: 'El sabor de los Andes en tu mesa', rationale: 'Une el origen andino del nombre con el producto.' },
  { tagline: 'Dulzura que viene de altura', rationale: 'Juega con el estilo rústico y la sierra.' },
  { tagline: 'Hecho con cariño, como en casa', rationale: 'Transmite calidez y tradición.' },
  { tagline: 'Fruta peruana, sabor de verdad', rationale: 'Resalta lo natural del rubro.' },
  { tagline: 'Cada frasco, un pedacito de valle', rationale: 'Evoca el origen de los ingredientes.' },
];

function fakeLlm(candidates: unknown) {
  const calls: AgentCompletionRequest[] = [];
  const complete = vi.fn(async (request: AgentCompletionRequest) => {
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
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'propose_taglines', arguments: JSON.stringify({ candidates }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    };
  });
  setAgentLlm({ complete });
  return { calls, complete };
}

const BRIEF = { business_category: 'alimentos', style_keywords: 'rústico, cálido', product_name: 'Mermelada de aguaymanto' };
const NAME = { business_name: { deliverableId: NAME_ID, value: 'Dulce Andino' } };
const sha = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

describe('tagline-agent handler', () => {
  afterEach(() => resetAgentLlm());

  it('returns five taglines with rationale, the approved name id and fingerprint, and generation metadata', async () => {
    const { calls } = fakeLlm(CANDIDATES);
    const result = await handler(message(BRIEF, NAME), undefined);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.map((a) => a.inline)).toEqual(CANDIDATES.map((c) => c.tagline));
    expect(result.artifacts.every((a) => a.kind === 'text')).toBe(true);
    expect(result.artifacts[2].metadata).toMatchObject({
      purpose: 'tagline',
      rationale: CANDIDATES[2].rationale,
      candidateIndex: 3,
      candidateCount: 5,
      agentCardVersion: '0.1.0',
      promptVersion: TAGLINE_PROMPT_VERSION,
      provider: 'openrouter',
      model: 'fake/naming-1',
      inputs: {
        business_name: { value: 'Dulce Andino', version: sha('Dulce Andino'), deliverableId: NAME_ID },
        business_category: { value: 'alimentos', version: sha('alimentos') },
        style_keywords: { value: 'rústico, cálido', version: sha('rústico, cálido') },
        product_name: { value: 'Mermelada de aguaymanto', version: sha('Mermelada de aguaymanto') },
      },
    });
    expect(typeof result.artifacts[0].metadata?.generatedAt).toBe('string');
    // The name is an upstream reference (KAN-35 trigger a): never compared with the brief.
    expect(Object.keys(recordedFieldVersions(result.artifacts[0].metadata)!).sort()).toEqual(['business_category', 'product_name', 'style_keywords']);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: 'naming',
      promptVersion: TAGLINE_PROMPT_VERSION,
      usage: { tenantId: TENANT, agentTaskId: TASK },
      request: { tool_choice: { type: 'function', function: { name: 'propose_taglines' } } },
    });
    const [system, user] = calls[0].request.messages;
    expect(system.content).toBe(TAGLINE_SYSTEM_PROMPT);
    expect(user.content).toContain('- Nombre comercial aprobado: "Dulce Andino"');
    expect(user.content).toContain('- Rubro: "alimentos"');
  });

  it('states the language rule and forbids availability claims in the prompt', () => {
    expect(TAGLINE_SYSTEM_PROMPT.toLowerCase()).toContain('usa español neutro latinoamericano, trata al usuario de tú, nunca voseo');
    expect(TAGLINE_SYSTEM_PROMPT).toContain('No digas que un lema o el nombre está disponible, libre, registrado o protegido, ni que es único.');
    expect(TAGLINE_PROMPT_VERSION).toBe('tagline-agent.v1');
  });

  it('adds «Iterar» observations as quoted notes', async () => {
    const { calls } = fakeLlm(CANDIDATES);
    await handler(message(BRIEF, NAME, { parentTaskId: TASK, observations: ['más "corto"'] }), undefined);
    expect(calls[0].request.messages[1].content).toContain(`Ajustes pedidos sobre la propuesta anterior: "más 'corto'".`);
  });

  it('fails without calling the model when the task carries no approved name', async () => {
    const { complete } = fakeLlm(CANDIDATES);
    const result = await handler(message(BRIEF), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'handler_threw' } });
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['fewer than five valid taglines', CANDIDATES.slice(0, 4)],
    ['a duplicated tagline', [...CANDIDATES.slice(0, 4), { tagline: 'el sabor de los andes en tu mesa', rationale: 'Repetido.' }]],
    ['a tagline over the length cap', [...CANDIDATES.slice(0, 4), { tagline: 'x'.repeat(81), rationale: 'Largo.' }]],
  ])('fails as invalid_output on %s', async (_label, candidates) => {
    fakeLlm(candidates);
    const result = await handler(message(BRIEF, NAME), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_output' } });
  });

  it('card: depends on the approved name and reuses the name card fields and hints exactly (pinned releases)', () => {
    expect(taglineCard['mypes:deliverable']).toEqual({ kind: 'tagline', dependsOn: ['business_name'] });
    expect(taglineCard['mypes:requirements']).toEqual(nameCard['mypes:requirements']);
    expect(taglineCard['mypes:ui'].tabLabel).toBe('Lema');
  });
});
