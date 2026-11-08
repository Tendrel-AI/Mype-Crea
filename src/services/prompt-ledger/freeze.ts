import { hashPromptContent } from '../../lib/prompt-ledger';
import type { PromptEntry } from './current-prompts';

export type Lock = Record<string, Record<string, string>>;
export interface FrozenFile {
  key: string;
  version: string;
  text: string;
  schema?: unknown;
  contentHash: string;
  frozenAt: string;
}

/** Where a developer bumps the version constant, for the error message. */
const VERSION_SOURCE: Record<string, string> = {
  extractor: 'src/services/ai-config/adapter-behavior.ts',
  responder: 'src/services/ai-config/adapter-behavior.ts',
  'name-agent': 'agents/name-agent/handler.ts',
  'tagline-agent': 'agents/tagline-agent/handler.ts',
  'logo-agent': 'agents/logo-agent/handler.ts',
};

export type FreezePlan =
  | { action: 'already-frozen'; key: string; version: string }
  | { action: 'write'; key: string; version: string; file: FrozenFile }
  | { action: 'error'; key: string; version: string; message: string };

/** Pure: decides what to do for each working prompt; the script only does the fs I/O. */
export function planFreeze(prompts: PromptEntry[], lock: Lock, now: string): FreezePlan[] {
  return prompts.map(({ key, version, text, schema }) => {
    const contentHash = hashPromptContent({ text, schema });
    const frozen = lock[key]?.[version];
    if (frozen === contentHash) return { action: 'already-frozen', key, version };
    if (frozen) {
      return {
        action: 'error', key, version,
        message: `${version} is frozen with different content: bump the version constant in ${VERSION_SOURCE[key] ?? 'the prompt source'} and run prompt:freeze again`,
      };
    }
    const file: FrozenFile = { key, version, text, ...(schema === undefined ? {} : { schema }), contentHash, frozenAt: now };
    return { action: 'write', key, version, file };
  });
}
