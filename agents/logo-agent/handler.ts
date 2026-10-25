/**
 * Logo agent handler.
 *
 * Reads `business_name`, `style_keywords`, and optional `color_palette` from
 * the dispatched A2AMessage's requirements, builds a Spanish prompt, and asks
 * the centralized image generator (src/services/image) for a PNG URL. Returns
 * one image artifact. No DB writes, no R2 upload, no versioning — those are
 * downstream concerns left to a future PR.
 *
 * The handler depends on IImageGenerator, never on a specific provider, so
 * swapping fal for another vendor never touches this file.
 *
 * Logging: this handler runs inside the agent worker process (architecturally
 * separate from the orchestrator), so it owns its own logger scope. Every
 * step from prompt-build through generator return is logged with the
 * canonical `taskId` so the lifecycle is auditable end-to-end alongside the
 * worker's logs.
 *
 * Failures: an image-generation error is returned as a failed A2ATaskResult
 * whose `error.kind` is the typed kind from the image service
 * (`content_policy`, `config_missing`, `rate_limited`, `timeout`, …), or
 * `handler_threw` when the error carries no kind (architecture §2.5).
 */
import type { AgentHandler } from '../../src/core/agent-types';
import { taskErrorFromThrown } from '../../src/core/task-errors';
import { getImageGenerator } from '../../src/services/image';
import { loggerFor } from '../../src/services/logger';

const log = loggerFor('agent.logo-agent');

interface LogoRequirements {
  readonly business_name: string;
  readonly style_keywords: string;
  readonly color_palette?: string;
}

export function buildLogoPrompt(reqs: LogoRequirements): string {
  const parts = [
    `Diseña un logo profesional para el negocio "${reqs.business_name}".`,
    `Estilo: ${reqs.style_keywords}.`,
  ];
  if (reqs.color_palette) {
    parts.push(`Paleta de colores: ${reqs.color_palette}.`);
  }
  parts.push('Limpio, vectorizado, alta resolución, sin texto adicional.');
  return parts.join(' ');
}

export const handler: AgentHandler<undefined> = async (message) => {
  const child = log.child({
    op: 'handle',
    taskId: message.taskId,
    tenantId: message.tenantId,
    agentId: message.agentId,
    agentCardVersion: message.agentCardVersion,
  });

  const reqs = message.requirements as unknown as LogoRequirements;
  child.info(
    {
      requirementKeys: Object.keys(message.requirements),
      hasBusinessName: Boolean(reqs.business_name),
      hasStyleKeywords: Boolean(reqs.style_keywords),
      hasColorPalette: Boolean(reqs.color_palette),
    },
    'agent.logo.start',
  );

  const prompt = buildLogoPrompt(reqs);
  child.info({ promptLength: prompt.length }, 'agent.logo.prompt_built');

  const startedAt = Date.now();
  let url: string;
  let providerId: string;
  let modelId: string;
  try {
    const result = await getImageGenerator().generate({
      prompt,
      purpose: 'logo',
    });
    url = result.url;
    providerId = result.providerId;
    modelId = result.modelId;
  } catch (err) {
    const error = taskErrorFromThrown(err);
    child.error(
      { err, errorKind: error.kind, durationMs: Date.now() - startedAt },
      'agent.logo.image_generation_failed',
    );
    return {
      status: 'failed',
      taskId: message.taskId,
      error,
      completedAt: new Date().toISOString(),
    };
  }

  child.info(
    {
      providerId,
      modelId,
      durationMs: Date.now() - startedAt,
      hasUrl: Boolean(url),
    },
    'agent.logo.image_generated',
  );

  return {
    status: 'completed',
    taskId: message.taskId,
    artifacts: [
      {
        kind: 'image',
        url,
        metadata: { provider: providerId, model: modelId, prompt, purpose: 'logo' },
      },
    ],
    completedAt: new Date().toISOString(),
  };
};
