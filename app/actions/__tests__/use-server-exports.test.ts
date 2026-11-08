import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Next.js rejects a "use server" module that exports anything but async functions (types are erased).
const DIR = join(__dirname, '..');
const NON_FUNCTION_EXPORT = /^export\s+(const|let|var|class|enum|default\s+(?!async))/m;

describe('"use server" action files', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(DIR, file), 'utf8');
    if (!/^['"]use server['"]/m.test(source)) continue;
    it(`${file} exports only async functions`, () => {
      expect(source.match(NON_FUNCTION_EXPORT)?.[0]).toBeUndefined();
    });
  }
});
