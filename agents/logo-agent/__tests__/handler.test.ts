/**
 * Unit tests for the logo-agent handler. Inject a fake IImageGenerator via
 * setImageGenerator so we never call fal. Verify:
 *   - returned A2ATaskResult is completed with one image artifact
 *   - artifact metadata includes provider, model, prompt, purpose
 *   - prompt construction includes business_name + style_keywords + color_palette when present
 *   - color_palette is omitted from the prompt when not supplied
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOGO_PROMPT_VERSION, buildLogoPrompt, handler } from '../handler';
import { resetImageGenerator, setImageGenerator } from '../../../src/services/image';
import type { ImageRequest, ImageResult } from '../../../src/services/image';
import type { A2AMessage } from '../../../src/core/agent-types';
import { TaskError } from '../../../src/core/task-errors';
import { inputVersion } from '../../../src/core/deliverable-inputs';

function makeMessage(reqs: Record<string, unknown>): A2AMessage {
  return {
    taskId: '11111111-1111-1111-1111-111111111111' as A2AMessage['taskId'],
    tenantId: '22222222-2222-2222-2222-222222222222',
    agentId: 'logo-agent',
    agentCardVersion: '0.1.0',
    requirements: reqs,
    createdAt: new Date().toISOString(),
  };
}

const FAKE_SAFETY = {
  verdict: 'rejected',
  category: 'sexual_content',
  classifier: 'fal-safety-checker',
  model: 'fake-model/1',
  policyVersion: 'logo-safety.v1',
  checkedAt: '2026-11-03T00:00:00.000Z',
} as const;

function fakeGenerator(captured: ImageRequest[]) {
  return {
    generate: vi.fn(async (req: ImageRequest): Promise<ImageResult> => {
      captured.push(req);
      return {
        url: 'https://fake.cdn/logo.png',
        providerId: 'fake-provider',
        modelId: 'fake-model/1',
        latencyMs: 42,
        safety: FAKE_SAFETY,
      };
    }),
  };
}

describe('logo-agent handler', () => {
  afterEach(() => {
    resetImageGenerator();
  });

  it('returns one image artifact with provider + model + prompt + purpose metadata', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));

    const result = await handler(
      makeMessage({
        business_name: 'Café Andino',
        style_keywords: 'minimalista, andino',
        color_palette: 'tierra y verde',
      }),
      undefined,
    );

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts).toHaveLength(1);
    const [artifact] = result.artifacts;
    expect(artifact.kind).toBe('image');
    expect(artifact.url).toBe('https://fake.cdn/logo.png');
    expect(artifact.metadata).toMatchObject({
      provider: 'fake-provider',
      model: 'fake-model/1',
      purpose: 'logo',
      // KAN-29: the provenance the deliverables panel shows.
      promptVersion: LOGO_PROMPT_VERSION,
      agentCardVersion: '0.1.0',
    });
    expect(artifact.metadata?.prompt).toContain('Café Andino');
    // KAN-35: the fields the prompt used, with the shared sha256 fingerprint.
    expect(artifact.metadata?.inputs).toEqual({
      business_name: { value: 'Café Andino', version: inputVersion('Café Andino') },
      style_keywords: { value: 'minimalista, andino', version: inputVersion('minimalista, andino') },
      color_palette: { value: 'tierra y verde', version: inputVersion('tierra y verde') },
    });
    // KAN-33: the classifier result is recorded as-is, even when it is not `passed`.
    expect(artifact.metadata?.safety).toEqual(FAKE_SAFETY);
    expect(inputVersion('Café Andino')).toMatch(/^sha256:[0-9a-f]{64}$/);
    // KAN-43: the image is charged through the usage gate to this task's tenant.
    expect(captured[0].usage).toEqual({ tenantId: '22222222-2222-2222-2222-222222222222', agentTaskId: '11111111-1111-1111-1111-111111111111' });
  });

  it('passes a prompt to the generator that includes business_name, style_keywords, and color_palette', async () => {
    const captured: ImageRequest[] = [];
    setImageGenerator(fakeGenerator(captured));

    await handler(
      makeMessage({
        business_name: 'Café Andino',
        style_keywords: 'minimalista, andino',
        color_palette: 'tierra y verde',
      }),
      undefined,
    );

    expect(captured).toHaveLength(1);
    const sent = captured[0];
    expect(sent.purpose).toBe('logo');
    expect(sent.prompt).toContain('Café Andino');
    expect(sent.prompt).toContain('minimalista, andino');
    expect(sent.prompt).toContain('tierra y verde');
  });

  it('omits the palette sentence from the prompt when color_palette is not supplied', () => {
    const withPalette = buildLogoPrompt({
      business_name: 'X',
      style_keywords: 'y',
      color_palette: 'azul',
    });
    const withoutPalette = buildLogoPrompt({
      business_name: 'X',
      style_keywords: 'y',
    });
    expect(withPalette).toContain('Paleta de colores: azul');
    expect(withoutPalette).not.toContain('Paleta de colores');
  });

  it('appends Iterar observations as a quoted, single-line note (KAN-28)', () => {
    const prompt = buildLogoPrompt(
      { business_name: 'X', style_keywords: 'y' },
      { observations: ['Hazlo más "azul"\n y moderno', '   '] },
    );
    expect(prompt).toContain(`Ajustes pedidos sobre la versión anterior: "Hazlo más 'azul' y moderno".`);
    expect(buildLogoPrompt({ business_name: 'X', style_keywords: 'y' }, { observations: [] })).not.toContain('Ajustes');
  });

  it.each([
    ['content_policy', new TaskError('content_policy', 'blocked by safety filter')],
    ['config_missing', new TaskError('config_missing', 'FAL_KEY is not set')],
    ['timeout', new TaskError('timeout', 'request timed out')],
    ['handler_threw', new Error('unexpected')],
  ] as const)('returns a failed result with kind %s when image generation fails (KAN-58)', async (kind, err) => {
    setImageGenerator({ generate: vi.fn(async () => { throw err; }) });

    const result = await handler(
      makeMessage({ business_name: 'Café Andino', style_keywords: 'minimalista' }),
      undefined,
    );

    expect(result).toMatchObject({
      status: 'failed',
      taskId: '11111111-1111-1111-1111-111111111111',
      error: { kind, message: err.message },
    });
  });
});
