import { createCurrentAdapterBehaviorSnapshot } from '../ai-config/adapter-behavior';
import { LOGO_PROMPT_TEMPLATE, LOGO_PROMPT_VERSION } from '../../../agents/logo-agent/handler';
import { NAME_PROMPT_VERSION, NAME_SYSTEM_PROMPT, NAME_TOOL } from '../../../agents/name-agent/handler';
import { TAGLINE_PROMPT_VERSION, TAGLINE_SYSTEM_PROMPT, TAGLINE_TOOL } from '../../../agents/tagline-agent/handler';
import { SOCIAL_PROMPT_VERSION, SOCIAL_SYSTEM_PROMPT, SOCIAL_TOOL } from '../../../agents/social-agent/handler';

export interface PromptEntry {
  key: string;
  version: string;
  text: string;
  schema?: unknown;
}

/** The working prompts (what the code uses today), one key per agent/adapter. */
export function currentPrompts(): PromptEntry[] {
  const { extractor, responder } = createCurrentAdapterBehaviorSnapshot();
  const { promptTemplate: extractorText, promptVersion: extractorVersion, ...extractorSchema } = extractor;
  const { promptTemplate: responderText, promptVersion: responderVersion, ...responderRest } = responder;
  return [
    { key: 'extractor', version: extractorVersion, text: extractorText, schema: extractorSchema },
    { key: 'responder', version: responderVersion, text: responderText, schema: responderRest },
    { key: 'name-agent', version: NAME_PROMPT_VERSION, text: NAME_SYSTEM_PROMPT, schema: NAME_TOOL },
    { key: 'tagline-agent', version: TAGLINE_PROMPT_VERSION, text: TAGLINE_SYSTEM_PROMPT, schema: TAGLINE_TOOL },
    { key: 'logo-agent', version: LOGO_PROMPT_VERSION, text: LOGO_PROMPT_TEMPLATE },
    { key: 'social-agent', version: SOCIAL_PROMPT_VERSION, text: SOCIAL_SYSTEM_PROMPT, schema: SOCIAL_TOOL },
  ];
}
