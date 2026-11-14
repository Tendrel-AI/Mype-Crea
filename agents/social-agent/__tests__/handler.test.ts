/**
 * social-agent handler with a fake IAgentLlm and a fake IImageGenerator: the formula prompt is rendered from the
 * director's slots, user slots win, the product photo goes as a data: reference, failures are typed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ getObject: vi.fn<(key: string) => Promise<Uint8Array | null>>() }));
vi.mock('../../../src/services/storage/brand-upload', () => ({ brandFileStorage: () => storage }));

import { AD_SLOTS, SOCIAL_PROMPT_VERSION, SOCIAL_SYSTEM_PROMPT, SOCIAL_TOOL, buildSocialMessages, handler, parseAdSlots, renderAdPrompt } from '../handler';
import { getFrozenPrompt } from '../../../src/services/prompts';
import { isPresentable } from '../../../src/core/deliverable-safety';
import { resetAgentLlm, setAgentLlm, type AgentCompletionRequest } from '../../../src/services/llm/agent-completion';
import { resetImageGenerator, setImageGenerator } from '../../../src/services/image';
import type { ImageRequest } from '../../../src/services/image';
import type { A2AMessage } from '../../../src/core/agent-types';
import { TaskError } from '../../../src/core/task-errors';

const SLOTS = {
  subject: 'a glass bottle of purple chicha morada',
  medium: 'expired 35mm film frame',
  action: 'condensation dripping down the glass',
  lens: '50mm lens',
  composition: 'extreme off-center cropping with deep negative space',
  lighting: 'harsh on-camera flash',
  textures: 'wet glass versus rough matte paper label',
  environment: 'a scuffed zinc counter',
  palette: 'cyan-tinted shadow palette',
  filters: 'ISO 800 grain and light leaks',
};
const SAFETY = { verdict: 'passed', category: null, classifier: 'fal-safety-checker', model: 'm', policyVersion: 'p', checkedAt: '2026-11-13T00:00:00.000Z' } as const;

const message = (requirements: Record<string, unknown>, iteration?: A2AMessage['iteration']): A2AMessage => ({
  taskId: '11111111-1111-1111-1111-111111111111' as A2AMessage['taskId'],
  tenantId: '22222222-2222-2222-2222-222222222222',
  agentId: 'social-agent',
  agentCardVersion: '0.2.0',
  requirements,
  ...(iteration ? { iteration } : {}),
  createdAt: new Date().toISOString(),
});

function fakes(args: string = JSON.stringify(SLOTS), imageError?: Error) {
  const llmCalls: AgentCompletionRequest[] = [];
  const images: ImageRequest[] = [];
  setAgentLlm({
    complete: vi.fn(async (request: AgentCompletionRequest) => {
      llmCalls.push(request);
      return {
        provider: 'openrouter' as const,
        model: 'fake/naming-1',
        completion: { id: 'c', choices: [{ message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 't', type: 'function' as const, function: { name: 'fill_ad_prompt', arguments: args } }] }, finish_reason: 'tool_calls' }] },
      };
    }),
  });
  setImageGenerator({
    generate: vi.fn(async (req: ImageRequest) => {
      images.push(req);
      if (imageError) throw imageError;
      return { url: 'https://fake.cdn/ad.png', providerId: 'fake', modelId: 'fake-img/1', latencyMs: 1, safety: SAFETY };
    }),
  });
  return { llmCalls, images };
}

describe('social-agent handler', () => {
  afterEach(() => {
    resetAgentLlm();
    resetImageGenerator();
    storage.getObject.mockReset();
  });

  it('renders the formula from the director slots and returns one presentable image artifact', async () => {
    const { llmCalls, images } = fakes();
    const result = await handler(message({ ad_brief: 'sorpréndeme', business_name: 'Chicha Sol' }), undefined);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(images[0].prompt).toBe(renderAdPrompt(SLOTS as never));
    expect(images[0]).toMatchObject({ purpose: 'social', usage: { agentTaskId: '11111111-1111-1111-1111-111111111111' } });
    expect(images[0].referenceUrls).toBeUndefined();
    expect(llmCalls[0]).toMatchObject({ purpose: 'naming', promptVersion: SOCIAL_PROMPT_VERSION });
    expect(result.artifacts[0]).toMatchObject({ kind: 'image', url: 'https://fake.cdn/ad.png' });
    expect(result.artifacts[0].metadata).toMatchObject({
      purpose: 'social_ad', slots: SLOTS, director: { provider: 'openrouter', model: 'fake/naming-1' }, productPhoto: null, promptVersion: SOCIAL_PROMPT_VERSION,
      inputs: { ad_brief: { value: 'sorpréndeme' }, business_name: { value: 'Chicha Sol' } },
    });
    expect(isPresentable(result.artifacts[0].metadata?.safety as never)).toBe(true);
  });

  it('lets a user-given slot override the director and quotes it as locked', async () => {
    const { llmCalls, images } = fakes();
    await handler(message({ ad_brief: 'x', ad_lighting: 'candlelight' }), undefined);
    expect(images[0].prompt).toContain('The lighting consists of candlelight,');
    expect(llmCalls[0].request.messages[1].content).toContain('- lighting: "candlelight"');
  });

  it('sends the product photo as a data: reference when the bytes exist', async () => {
    const { images } = fakes();
    storage.getObject.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const photos = [{ fileId: 'f1', storageKey: 'k1', contentType: 'image/png', originalName: 'a.png' }];
    const result = await handler(message({ ad_brief: 'x', product_photos: photos }), undefined);
    expect(images[0].referenceUrls).toEqual(['data:image/png;base64,AQID']);
    expect(result.status === 'completed' && result.artifacts[0].metadata?.productPhoto).toEqual({ fileId: 'f1', originalName: 'a.png' });
  });

  it('tells the image model to keep the product of the reference photo', async () => {
    const { images } = fakes();
    storage.getObject.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await handler(message({ ad_brief: 'x', product_photos: [{ fileId: 'f1', storageKey: 'k1', contentType: 'image/png', originalName: 'a.png' }] }), undefined);
    expect(images[0].prompt).toBe(renderAdPrompt(SLOTS as never, true));
    expect(images[0].prompt).toMatch(/exactly the one in the reference image/);
  });

  it('prints the director headline on the image, and leaves it out when empty (D60)', async () => {
    const { images } = fakes(JSON.stringify({ ...SLOTS, headline: 'Fría, como en el mercado' }));
    const result = await handler(message({ ad_brief: 'x' }), undefined);
    expect(images[0].prompt).toContain('The bold printed headline "Fría, como en el mercado" is integrated into the composition');
    expect(result.status === 'completed' && result.artifacts[0].metadata?.slots).toMatchObject({ headline: 'Fría, como en el mercado' });
    const empty = fakes(JSON.stringify({ ...SLOTS, headline: '' }));
    await handler(message({ ad_brief: 'x' }), undefined);
    expect(empty.images[0].prompt).toBe(renderAdPrompt(SLOTS as never));
  });

  it('generates without reference when the photo bytes are missing', async () => {
    const { images } = fakes();
    storage.getObject.mockResolvedValue(null);
    const photos = [{ fileId: 'f1', storageKey: 'k1', contentType: 'image/png', originalName: 'a.png' }];
    const result = await handler(message({ ad_brief: 'x', product_photos: photos }), undefined);
    expect(result.status).toBe('completed');
    expect(images[0].referenceUrls).toBeUndefined();
  });

  it('adds the iteration observations to the director message, flattened and quoted', async () => {
    const { llmCalls } = fakes();
    await handler(message({ ad_brief: 'x' }, { parentTaskId: 'p' as never, observations: ['más "oscuro"\ny crudo'] }), undefined);
    expect(llmCalls[0].request.messages[1].content).toContain(`Ajustes pedidos sobre la versión anterior: "más 'oscuro' y crudo".`);
  });

  it('fails with invalid_output on bad director output', async () => {
    fakes('not json');
    const result = await handler(message({ ad_brief: 'x' }), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_output' } });
  });

  it('fails with the typed image error', async () => {
    fakes(JSON.stringify(SLOTS), new TaskError('content_policy', 'blocked'));
    const result = await handler(message({ ad_brief: 'x' }), undefined);
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'content_policy' } });
  });
});

describe('ad prompt helpers', () => {
  it('parseAdSlots requires the subject and all nine slots', () => {
    expect(parseAdSlots(JSON.stringify(SLOTS))).toEqual(SLOTS);
    for (const key of ['subject', ...AD_SLOTS]) {
      expect(() => parseAdSlots(JSON.stringify({ ...SLOTS, [key]: ' ' }))).toThrow(TaskError);
    }
  });

  it('v2 frozen text and tool are the working director prompt and tool; pinned v1 has no headline', () => {
    const v2 = getFrozenPrompt('social-agent', 'social-agent.v2')!;
    expect(v2.text).toBe(SOCIAL_SYSTEM_PROMPT);
    expect(v2.schema).toEqual(JSON.parse(JSON.stringify(SOCIAL_TOOL)));
    expect(SOCIAL_PROMPT_VERSION).toBe('social-agent.v2');
    expect(parseAdSlots(JSON.stringify(SLOTS))).not.toHaveProperty('headline');
  });

  it('buildSocialMessages tells the director to be surprising when there is no data', () => {
    expect(buildSocialMessages({}, undefined)[1].content).toMatch(/sorprende/);
  });
});
