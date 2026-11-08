/** `npm run prompt:freeze [key...]`: freezes the working prompts as immutable files under prompts/. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentPrompts } from '../src/services/prompt-ledger/current-prompts';
import { planFreeze, type Lock } from '../src/services/prompt-ledger/freeze';

const dir = join(process.cwd(), 'prompts');
const lockPath = join(dir, 'lock.json');
const lock: Lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};
const keys = process.argv.slice(2);
const all = currentPrompts();
const unknown = keys.filter((k) => !all.some((p) => p.key === k));
if (unknown.length) {
  console.error(`unknown key(s): ${unknown.join(', ')}. Known: ${all.map((p) => p.key).join(', ')}`);
  process.exit(1);
}

let failed = false;
for (const plan of planFreeze(keys.length ? all.filter((p) => keys.includes(p.key)) : all, lock, new Date().toISOString())) {
  const id = `${plan.key}@${plan.version}`;
  if (plan.action === 'already-frozen') console.log(`${id}: already frozen`);
  else if (plan.action === 'error') { console.error(`${id}: ${plan.message}`); failed = true; }
  else {
    const file = join(dir, plan.key, `${plan.version}.json`);
    mkdirSync(join(dir, plan.key), { recursive: true });
    writeFileSync(file, JSON.stringify(plan.file, null, 2) + '\n', { flag: 'wx' }); // wx: never overwrite
    (lock[plan.key] ??= {})[plan.version] = plan.file.contentHash;
    console.log(`${id}: frozen -> prompts/${plan.key}/${plan.version}.json (${plan.file.contentHash})`);
  }
}

const sorted = Object.fromEntries(
  Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))]),
);
mkdirSync(dir, { recursive: true });
writeFileSync(lockPath, JSON.stringify(sorted, null, 2) + '\n');
process.exit(failed ? 1 : 0);
