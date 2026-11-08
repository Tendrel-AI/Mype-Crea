import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

// Separator-terminated so a sibling like `prompt-ledger-x` is rejected.
const isInside = (p: string) => p === root || p.startsWith(root + path.sep);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

describe('prompt-ledger import boundary', () => {
  it('imports only node: builtins, vitest (tests) and relative paths inside the folder', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(root)) {
      const isTest = file.includes(`${path.sep}__tests__${path.sep}`);
      const src = readFileSync(file, 'utf8');
      const specs = [...src.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specs) {
        const ok = spec.startsWith('node:')
          || (isTest && spec === 'vitest')
          || (spec.startsWith('.') && isInside(path.resolve(path.dirname(file), spec)));
        if (!ok) offenders.push(`${path.relative(root, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
