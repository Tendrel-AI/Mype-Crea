// Developer tooling (evals, CLI) only: nothing under app/, components/ or request paths may import this folder.
import pg from 'pg';
import { PromptLedger } from '../../lib/prompt-ledger';
import { PostgresLedgerStore } from './postgres-store';

/** Owner connection (DATABASE_URL, the one migrations use); never APP_DATABASE_URL: app_user is denied by design. */
export function createDeveloperLedger(connectionString = process.env.DATABASE_URL): { ledger: PromptLedger; close(): Promise<void> } {
  if (!connectionString) throw new Error('DATABASE_URL (owner connection) is required for the prompt ledger');
  const pool = new pg.Pool({ connectionString, max: 2 });
  return { ledger: new PromptLedger({ store: new PostgresLedgerStore(pool as never) }), close: () => pool.end() };
}
