/**
 * Runtime access to the frozen prompt versions (D22). Files are loaded through the static imports
 * of the generated `prompts/index.ts` (no fs at runtime: the standalone build must ship them) and
 * re-verified against `prompts/lock.json` on every read.
 */
import { frozenFiles, lock } from '../../../prompts';
import { hashPromptContent } from '../../lib/prompt-ledger';
import type { FrozenFile } from '../prompt-ledger/freeze';
import { loggerFor } from '../logger';

const log = loggerFor('services.prompts');
const files = frozenFiles as unknown as FrozenFile[];
const hashes = lock as Record<string, Record<string, string>>;

export const PROMPT_KEYS = ['extractor', 'responder', 'name-agent', 'tagline-agent', 'logo-agent'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];
export type PromptVersions = Record<string, string>;

const versionNumber = (version: string): number => Number(/v(\d+)$/.exec(version)?.[1] ?? -1);

/** `PROMPT_<KEY>` (e.g. PROMPT_NAME_AGENT) or, unset, the highest frozen `vN` of that key. */
export function activePromptVersion(key: PromptKey): string {
  const pinned = process.env[`PROMPT_${key.toUpperCase().replace(/-/g, '_')}`]?.trim();
  if (pinned) return pinned;
  const latest = files.filter((f) => f.key === key).sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0];
  return latest?.version ?? '';
}

export const activePromptVersions = (): PromptVersions => Object.fromEntries(PROMPT_KEYS.map((key) => [key, activePromptVersion(key)]));

/** The frozen entry, or undefined when the version is unknown or its content no longer matches the lock. */
export function getFrozenPrompt(key: string, version: string): FrozenFile | undefined {
  const file = files.find((f) => f.key === key && f.version === version);
  if (!file) return undefined;
  const hash = hashPromptContent({ text: file.text, schema: file.schema });
  if (hash !== hashes[key]?.[version] || hash !== file.contentHash) {
    log.error({ key, version }, 'prompt.hash_mismatch');
    return undefined;
  }
  return file;
}

/** Problems with the active versions (empty = ready). Details go to the logs, never to a response. */
export function checkActivePrompts(): string[] {
  return PROMPT_KEYS.flatMap((key) => {
    const version = activePromptVersion(key);
    return getFrozenPrompt(key, version) ? [] : [`${key}@${version || '(none)'}: missing or tampered`];
  });
}

/** The conversation's pinned version of `key` if it can still be read, else the active one (logged). */
export function resolvePinnedPrompt(key: PromptKey, pinned: PromptVersions | undefined): FrozenFile | undefined {
  const active = activePromptVersion(key);
  const wanted = pinned?.[key];
  const file = wanted ? getFrozenPrompt(key, wanted) : undefined;
  if (file) return file;
  if (wanted && wanted !== active) log.warn({ key, pinned: wanted, used: active }, 'prompt.pin.fallback');
  return getFrozenPrompt(key, active);
}

/** What an agent handler runs: the prompt the worker attached (pinned version) or the active frozen one. */
export function agentPrompt(attached: { version: string; text: string; schema?: unknown } | undefined, key: PromptKey) {
  const prompt = attached ?? getFrozenPrompt(key, activePromptVersion(key));
  if (!prompt) throw new Error(`No frozen prompt available for ${key}.`);
  return prompt;
}
