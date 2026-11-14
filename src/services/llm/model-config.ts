/** Read and validate one provider model override without consulting live APIs. */
export function readModelOverride(
  variable: string,
  defaultModel: string,
  isValidForProvider: (model: string) => boolean,
): string {
  const configured = process.env[variable];
  if (configured === undefined) return defaultModel;

  const model = configured.trim();
  if (!model) {
    throw new Error(`${variable} must not be blank.`);
  }
  if (!isValidForProvider(model)) {
    throw new Error(`${variable} has an invalid model ID for its configured provider.`);
  }
  return model;
}

export function isOpenRouterModelId(model: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(model);
}

export function isAnthropicModelId(model: string): boolean {
  return /^claude-[a-z0-9][a-z0-9-]*$/i.test(model);
}
