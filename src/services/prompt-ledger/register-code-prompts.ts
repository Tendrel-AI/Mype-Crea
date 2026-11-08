import { execSync } from 'node:child_process';
import type { PromptLedger } from '../../lib/prompt-ledger';
import { createCurrentAdapterBehaviorSnapshot } from '../ai-config/adapter-behavior';
import { buildLogoPrompt, LOGO_PROMPT_VERSION } from '../../../agents/logo-agent/handler';
import { NAME_PROMPT_VERSION, NAME_SYSTEM_PROMPT, NAME_TOOL } from '../../../agents/name-agent/handler';
import { TAGLINE_PROMPT_VERSION, TAGLINE_SYSTEM_PROMPT, TAGLINE_TOOL } from '../../../agents/tagline-agent/handler';

function currentCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers the prompt versions currently in code (idempotent). Keys follow llm_calls.purpose where
 * one exists (extractor, responder, naming), else the agent id (logo-agent has no llm_calls rows).
 */
export async function registerCodePrompts(ledger: PromptLedger, gitCommit: string | undefined = currentCommit()) {
  const { extractor, responder } = createCurrentAdapterBehaviorSnapshot();
  const { promptTemplate: extractorText, promptVersion: extractorVersion, ...extractorSchema } = extractor;
  const { promptTemplate: responderText, promptVersion: responderVersion, ...responderRest } = responder;
  const logoText = buildLogoPrompt({ business_name: '{{business_name}}', style_keywords: '{{style_keywords}}', color_palette: '{{color_palette}}' });
  const entries = [
    { key: 'extractor', version: extractorVersion, text: extractorText, schema: extractorSchema },
    { key: 'responder', version: responderVersion, text: responderText, schema: responderRest },
    { key: 'naming', version: NAME_PROMPT_VERSION, text: NAME_SYSTEM_PROMPT, schema: NAME_TOOL },
    { key: 'naming', version: TAGLINE_PROMPT_VERSION, text: TAGLINE_SYSTEM_PROMPT, schema: TAGLINE_TOOL },
    { key: 'logo-agent', version: LOGO_PROMPT_VERSION, text: logoText },
  ];
  return Promise.all(entries.map((e) => ledger.registerVersion({ ...e, gitCommit })));
}
