/**
 * Developer-only prompt ledger report (F14 / D19). Aggregates only: no tenant ids, business
 * values or user text. Connects with the OWNER url (DATABASE_URL); never run through the app.
 *
 *   npm run ledger:report -- <key>                                   list versions
 *   npm run ledger:report -- <key> <versionA> <versionB> [--kind eval|production]
 */
import { parseArgs } from 'node:util';
import { createDeveloperLedger, registerCodePrompts } from '../src/services/prompt-ledger';
import { formatComparison, formatHistory } from './prompt-ledger-report-format';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { kind: { type: 'string' } } });
  const [key, versionA, versionB] = positionals;
  const kind = values.kind;
  if (!key || (versionA && !versionB) || (kind !== undefined && kind !== 'eval' && kind !== 'production')) {
    throw new Error('Usage: ledger:report <key> [<versionA> <versionB> [--kind eval|production]]');
  }
  const { ledger, close } = createDeveloperLedger();
  try {
    await registerCodePrompts(ledger);
    if (!versionA) return void console.log(formatHistory(key, await ledger.history(key)));
    console.log(formatComparison(await ledger.compare(key, versionA, versionB, { kind }), versionA, versionB));
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
