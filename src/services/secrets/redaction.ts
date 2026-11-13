/**
 * Runtime secrets that must never reach logs or stored evidence. Env secrets are read live;
 * secrets that only exist in memory (decrypted tenant sub-keys) register here when decrypted.
 */
const registered = new Set<string>();

const ENV_SECRETS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_PROVISIONING_KEY', 'PROVIDER_KEY_KEK'] as const;

export function registerSecret(value: string): void {
  if (value.length >= 8) registered.add(value);
}

export function knownSecrets(): string[] {
  const fromEnv = ENV_SECRETS.map((name) => process.env[name]).filter((v): v is string => Boolean(v));
  return [...fromEnv, ...registered];
}

/** Test hook. */
export function resetRegisteredSecrets(): void {
  registered.clear();
}
