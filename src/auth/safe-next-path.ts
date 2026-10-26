/**
 * Validate a post-login `next` destination (KAN-80). Accept only a same-origin relative path that
 * starts with a single `/`; anything else returns `fallback`. Pure, so it is unit tested directly.
 */

const MAX_LENGTH = 2048;
const PLACEHOLDER_ORIGIN = 'http://next-path.invalid';
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

function isSafeShape(value: string): boolean {
  // A second `/` or a `\` (which browsers treat as `/`) makes a protocol-relative URL.
  return value.startsWith('/') && value[1] !== '/' && !value.includes('\\') && !CONTROL_CHARACTERS.test(value);
}

export function safeNextPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return fallback;
  if (!isSafeShape(raw)) return fallback;
  // Reject encoded tricks too: the decoded form must pass the same checks (`/%2F/evil.com`).
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return fallback; }
  if (!isSafeShape(decoded)) return fallback;
  let url: URL;
  try { url = new URL(raw, PLACEHOLDER_ORIGIN); } catch { return fallback; }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;
  return raw;
}
