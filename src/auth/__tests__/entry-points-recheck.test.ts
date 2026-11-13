/**
 * D4/D52: every tenant entry point re-resolves identity on each call (no cache), so a deactivated
 * member is blocked on the very next request. This is a structural guard: a new route or server
 * action that reaches tenant data without going through an identity guard fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const GUARD = /resolveIdentity|requireTenantAdmin|requirePlatformAdmin|requireGlobalMfa|requireGlobalAdmin|authorizeConversation|resolveRealRoles/;
/** Public / non-tenant entry points, or pure helpers imported by guarded actions. */
const EXEMPT = new Set(['app/api/health/route.ts', 'app/api/health/ready/route.ts', 'app/actions/prior-decision.ts', 'app/actions/conversation-access.ts', 'app/actions/auth.ts']);

function walk(dir: string, match: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__') return [];
    if (statSync(full).isDirectory()) return walk(full, match);
    return match(full) ? [full] : [];
  });
}

describe('identity is re-resolved per call at every entry point', () => {
  const files = [
    ...walk(join(ROOT, 'app/api'), (f) => f.endsWith('/route.ts')),
    ...walk(join(ROOT, 'app/actions'), (f) => f.endsWith('.ts')),
  ].map((f) => f.slice(ROOT.length + 1)).filter((f) => !EXEMPT.has(f));

  it.each(files)('%s goes through an identity guard', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(GUARD);
  });

  it('identity resolution holds no module-level cache', () => {
    const source = readFileSync(join(ROOT, 'src/auth/resolve-identity.ts'), 'utf8');
    expect(source).not.toMatch(/unstable_cache|new Map\(|let cached/);
  });
});
