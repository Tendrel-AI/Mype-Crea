/**
 * Module-level singleton for the configured IImageGenerator. Mirrors the
 * pattern in src/services/llm/index.ts: lazy construction inside
 * `getImageGenerator()` so importing this module during build/SSR doesn't
 * explode when env vars aren't set, and `setImageGenerator()` /
 * `resetImageGenerator()` for tests that need to swap in a fake.
 */
import { TaskError } from '../../core/task-errors';
import { FalImageProvider } from './fal-provider';
import { ImageGeneratorService, type ImageUsageResolver } from './generator';
import type { IImageGenerator } from './types';
import { repos, systemRepos } from '../../repos';
import { getConversationOwnerUserId } from '../../repos/conversations';
import type { ConversationId, TaskId } from '../../core/contracts';

export type {
  IImageGenerator,
  IImageProvider,
  ImagePurpose,
  ImageRequest,
  ImageResult,
} from './types';
export { ImageGeneratorService } from './generator';
export { FalImageProvider, classifyFalError } from './fal-provider';

let generator: IImageGenerator | undefined;

export function getImageGenerator(): IImageGenerator {
  if (generator) return generator;
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new TaskError(
      'config_missing',
      'FAL_KEY is not set. The image generator requires a fal.ai API key.',
    );
  }
  generator = new ImageGeneratorService(new FalImageProvider(apiKey), resolveImageUsage);
  return generator;
}

/** KAN-43: an image is charged to the owner of the task's conversation. Fails closed. */
const resolveImageUsage: ImageUsageResolver = async ({ tenantId, agentTaskId }) => {
  const tenant = { id: tenantId };
  const task = await systemRepos(tenant).agentTasks.findById(agentTaskId as TaskId);
  const owner = task ? await getConversationOwnerUserId(tenant, task.conversationId as ConversationId) : null;
  if (!task || !owner) throw new Error('Cannot attribute image usage: task or conversation owner not found.');
  return { ledger: repos(tenant, { id: owner }).usage, conversationId: task.conversationId, ownerUserId: owner };
};

/** Test hook: swap in a fake or clear the cached singleton. */
export function setImageGenerator(g: IImageGenerator | undefined): void {
  generator = g;
}

/** Test hook: drop the cached singleton so the next `getImageGenerator()` rebuilds. */
export function resetImageGenerator(): void {
  generator = undefined;
}
