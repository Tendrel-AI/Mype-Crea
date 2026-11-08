import { createCurrentAdapterBehaviorSnapshot } from '../ai-config/adapter-behavior';
import { buildLogoPrompt, LOGO_PROMPT_VERSION } from '../../../agents/logo-agent/handler';
import { NAME_PROMPT_VERSION, NAME_SYSTEM_PROMPT, NAME_TOOL } from '../../../agents/name-agent/handler';
import { TAGLINE_PROMPT_VERSION, TAGLINE_SYSTEM_PROMPT, TAGLINE_TOOL } from '../../../agents/tagline-agent/handler';

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
  const logoText = buildLogoPrompt({ business_name: '{{business_name}}', style_keywords: '{{style_keywords}}', color_palette: '{{color_palette}}' });
  return [
    { key: 'extractor', version: extractorVersion, text: extractorText, schema: extractorSchema },
    { key: 'responder', version: responderVersion, text: responderText, schema: responderRest },
    { key: 'name-agent', version: NAME_PROMPT_VERSION, text: NAME_SYSTEM_PROMPT, schema: NAME_TOOL },
    { key: 'tagline-agent', version: TAGLINE_PROMPT_VERSION, text: TAGLINE_SYSTEM_PROMPT, schema: TAGLINE_TOOL },
    { key: 'logo-agent', version: LOGO_PROMPT_VERSION, text: logoText },
  ];
}
