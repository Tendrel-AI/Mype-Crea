import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../safe-next-path';

const fallback = '/platform';

describe('safeNextPath (KAN-80)', () => {
  it.each([
    '/admin/ai',
    '/platform',
    '/platform/organizations/abc?tab=members#top',
    '/admin%20ai',
    '/',
  ])('accepts the same-origin relative path %s', (value) => {
    expect(safeNextPath(value, fallback)).toBe(value);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['an array (repeated query param)', ['/admin/ai', '/x']],
    ['a number', 42],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/admin/ai'],
    ['absolute https', 'https://x'],
    ['absolute with scheme and slashes', 'https://evil.com/admin/ai'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,hi'],
    ['relative without leading slash', 'admin/ai'],
    ['backslash after slash', '/\\evil.com'],
    ['backslash later in the path', '/admin\\..\\evil'],
    ['tab that browsers strip', '/\t/evil.com'],
    ['newline', '/admin\n/ai'],
    ['null byte', '/admin\u0000ai'],
    ['DEL character', '/admin\u007Fai'],
    ['encoded second slash', '/%2Fevil.com'],
    ['encoded slashes after the first', '/%2F%2Fevil.com'],
    ['encoded backslash', '/%5Cevil.com'],
    ['encoded tab', '/%09/evil.com'],
    ['double-encoded protocol-relative', '%252F%252Fevil.com'],
    ['encoded leading slashes', '%2F%2Fevil.com'],
    ['malformed percent escape', '/admin%E0%A4%A'],
    ['overly long', `/${'a'.repeat(2048)}`],
  ])('falls back for %s', (_label, value) => {
    expect(safeNextPath(value, fallback)).toBe(fallback);
  });
});
