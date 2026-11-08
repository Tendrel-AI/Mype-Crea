import { createHash } from 'node:crypto';

// Keys sorted recursively so object key order never changes the hash.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function hashPromptContent(content: { text: string; schema?: unknown }): string {
  const canonical = JSON.stringify(canonicalize({ text: content.text, schema: content.schema ?? null }));
  return createHash('sha256').update(canonical).digest('hex');
}
