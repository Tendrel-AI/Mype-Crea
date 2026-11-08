import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPromptContent } from '../../../lib/prompt-ledger';
import { currentPrompts } from '../current-prompts';

const dir = join(__dirname, '../../../../prompts');
const lock: Record<string, Record<string, string>> = existsSync(join(dir, 'lock.json')) ? JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8')) : {};
const files = existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(dir, d.name)).map((f) => ({ path: `${d.name}/${f}`, ...JSON.parse(readFileSync(join(dir, d.name, f), 'utf8')) })))
  : [];

describe('frozen prompts', () => {
  it('every file matches its lock hash and its recomputed hash, at the path of its key/version', () => {
    for (const f of files) {
      const hash = hashPromptContent({ text: f.text, schema: f.schema });
      expect(f.path, 'file path').toBe(`${f.key}/${f.version}.json`);
      expect(f.contentHash, `${f.path} contentHash`).toBe(hash);
      expect(lock[f.key]?.[f.version], `${f.path} lock entry`).toBe(hash);
    }
  });

  it('every lock entry has a file and no (key, version) repeats', () => {
    const ids = files.map((f) => `${f.key}@${f.version}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [key, versions] of Object.entries(lock)) {
      for (const version of Object.keys(versions)) expect(ids, `lock entry ${key}@${version} has no file`).toContain(`${key}@${version}`);
    }
  });

  it.each(currentPrompts().map((p) => [`${p.key}@${p.version}`, p] as const))('working prompt %s is frozen with identical content', (id, p) => {
    expect(
      lock[p.key]?.[p.version],
      `${id} is not frozen, or its content changed: bump the version constant and run \`npm run prompt:freeze\``,
    ).toBe(hashPromptContent({ text: p.text, schema: p.schema }));
  });
});
