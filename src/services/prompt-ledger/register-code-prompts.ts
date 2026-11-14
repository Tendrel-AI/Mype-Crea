import { execSync } from 'node:child_process';
import type { PromptLedger } from '../../lib/prompt-ledger';
import { currentPrompts } from './current-prompts';

function currentCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Registers the prompt versions currently in code (idempotent); keys come from `currentPrompts()`. */
export async function registerCodePrompts(ledger: PromptLedger, gitCommit: string | undefined = currentCommit()) {
  return Promise.all(currentPrompts().map((e) => ledger.registerVersion({ ...e, gitCommit })));
}
