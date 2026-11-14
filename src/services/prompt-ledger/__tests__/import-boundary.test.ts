import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');

function files(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (n === 'node_modules') return [];
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|mjs|js)$/.test(n) ? [p] : [];
    });
  } catch {
    return [];
  }
}

describe('prompt-ledger service boundary', () => {
  it('is not imported by app, components or runtime layers', () => {
    const offenders = ['app', 'components', 'src/core', 'src/adapters', 'src/workers']
      .flatMap((d) => files(join(root, d)))
      .filter((f) => !f.includes('__tests__') && /services\/prompt-ledger/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
