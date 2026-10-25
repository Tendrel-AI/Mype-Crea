// Deploy-time migration runner logic (KAN-83). The entry point is scripts/migrate-deploy.mjs
// (`npm run migrate:deploy`, the Railway pre-deploy command). Everything here is injectable so the
// guards and the redaction are unit-tested without a database (scripts/__tests__/).
//
// Contract:
//  - The admin connection comes ONLY from MIGRATION_DATABASE_URL. DATABASE_URL, APP_DATABASE_URL
//    and .env files are never used as the connection.
//  - Fails closed (exit code 1, one line) when the variable is missing, unparsable, has no explicit
//    user, uses the runtime role, or is the runtime connection (APP_DATABASE_URL).
//  - Never logs the URL, the password, or the host. Logs the database name, migration names and
//    durations only.
//  - Runs node-pg-migrate `up` with the same table, schema, order check, single transaction and
//    advisory lock as the `npm run migrate:*` CLI scripts, so both see the same history.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATION_URL_VAR = 'MIGRATION_DATABASE_URL';
export const RUNTIME_ROLE = 'app_user';

/** Matches the node-pg-migrate CLI defaults used by `npm run migrate:*` (no config file exists). */
export const MIGRATIONS_TABLE = 'pgmigrations';
export const MIGRATIONS_SCHEMA = ['public'];
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** node-pg-migrate throws this when another runner holds the advisory lock. */
export const LOCK_BUSY_MESSAGE = 'Another migration is already running';
export const DEFAULT_LOCK_RETRIES = 12;
export const DEFAULT_LOCK_RETRY_DELAY_MS = 5_000;
export const CONNECTION_TIMEOUT_MS = 15_000;

const LOG_PREFIX = '[migrate:deploy]';

export class DeployConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeployConfigError';
  }
}

function parsePostgresUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  return url;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function connectionIdentity(url) {
  return [
    safeDecode(url.username).toLowerCase(),
    url.hostname.toLowerCase(),
    url.port || '5432',
    safeDecode(url.pathname.slice(1)),
  ].join('|');
}

/**
 * Validates the deploy-time admin connection. Throws DeployConfigError with a message that never
 * contains any part of either URL.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ connectionString: string, database: string }}
 */
export function resolveMigrationConfig(env) {
  const raw = env[MIGRATION_URL_VAR]?.trim();
  if (!raw) {
    throw new DeployConfigError(
      `${MIGRATION_URL_VAR} is not set; refusing to migrate (DATABASE_URL and APP_DATABASE_URL are never used here).`,
    );
  }
  const url = parsePostgresUrl(raw);
  if (!url) {
    throw new DeployConfigError(
      `${MIGRATION_URL_VAR} is not a valid PostgreSQL URL (scheme postgres or postgresql); refusing to migrate.`,
    );
  }
  const database = safeDecode(url.pathname.slice(1));
  if (!database) {
    throw new DeployConfigError(`${MIGRATION_URL_VAR} names no database; refusing to migrate.`);
  }
  const user = safeDecode(url.username);
  if (!user) {
    throw new DeployConfigError(
      `${MIGRATION_URL_VAR} names no user, so the runtime role cannot be ruled out; refusing to migrate.`,
    );
  }
  if (user.toLowerCase() === RUNTIME_ROLE) {
    throw new DeployConfigError(
      `${MIGRATION_URL_VAR} uses the runtime role ${RUNTIME_ROLE}; migrations need the admin role.`,
    );
  }
  const appRaw = env.APP_DATABASE_URL?.trim();
  if (appRaw) {
    const appUrl = parsePostgresUrl(appRaw);
    const sameConnection =
      appRaw === raw || (appUrl !== null && connectionIdentity(appUrl) === connectionIdentity(url));
    if (sameConnection) {
      throw new DeployConfigError(
        `${MIGRATION_URL_VAR} is the runtime connection (APP_DATABASE_URL); migrations need the admin role.`,
      );
    }
  }
  return { connectionString: raw, database };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns a function that removes every known secret from a log line: any postgres URL, the
 * configured URL, its password (raw and decoded) and its host.
 *
 * @param {string | undefined} connectionString
 * @returns {(text: unknown) => string}
 */
export function makeRedactor(connectionString) {
  const literals = [];
  if (connectionString) {
    literals.push(connectionString);
    const url = parsePostgresUrl(connectionString);
    if (url) {
      for (const secret of [url.password, safeDecode(url.password)]) {
        if (secret.length >= 3) literals.push(secret);
      }
      if (url.hostname.length >= 4) literals.push(url.hostname);
    }
  }
  // Longest first so a password inside the URL does not break the URL replacement.
  literals.sort((a, b) => b.length - a.length);
  return (text) => {
    let out = typeof text === 'string' ? text : text instanceof Error ? (text.stack ?? text.message) : String(text);
    out = out.replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[redacted-url]');
    for (const literal of literals) {
      out = out.replace(new RegExp(escapeRegExp(literal), 'g'), '[redacted]');
    }
    return out;
  };
}

/**
 * Builds the node-pg-migrate runner options. Kept equal to what the CLI passes for
 * `node-pg-migrate up` with no flags, except the connection source and a connect timeout.
 */
export function buildRunnerOptions({ connectionString, logger, dir = MIGRATIONS_DIR }) {
  return {
    databaseUrl: { connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS },
    dir,
    migrationsTable: MIGRATIONS_TABLE,
    schema: MIGRATIONS_SCHEMA,
    direction: 'up',
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    verbose: false,
    logger,
  };
}

const CONNECT_FAILURE_PREFIX = 'could not connect to postgres';

/** One-line failure summary: message plus the driver or SQLSTATE code when there is one. */
export function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const code = typeof error.code === 'string' && error.code ? error.code : '';
  const message = error.message || error.name;
  if (!code) return message;
  return message.includes(code) ? message : `${message} (code ${code})`;
}

function isLockBusy(error) {
  return error instanceof Error && error.message === LOCK_BUSY_MESSAGE;
}

/**
 * Runs pending migrations and returns the process exit code (0 = ok or nothing pending).
 *
 * @param {object} deps
 * @param {Record<string, string | undefined>} deps.env
 * @param {(options: object) => Promise<Array<{ name: string }>>} deps.runner node-pg-migrate `runner`
 * @param {{ info: (line: string) => void, error: (line: string) => void }} [deps.out]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.lockRetries]
 * @param {number} [deps.lockRetryDelayMs]
 * @param {string} [deps.dir]
 */
export async function runDeployMigrations({
  env,
  runner,
  out = { info: (line) => console.log(line), error: (line) => console.error(line) },
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  lockRetries = DEFAULT_LOCK_RETRIES,
  lockRetryDelayMs = DEFAULT_LOCK_RETRY_DELAY_MS,
  dir,
}) {
  const started = now();
  const elapsed = () => `${now() - started}ms`;

  let config;
  try {
    config = resolveMigrationConfig(env);
  } catch (error) {
    // Config errors are built without URL fragments, but redact anyway: fail-safe.
    const redact = makeRedactor(env[MIGRATION_URL_VAR]);
    const message = error instanceof DeployConfigError ? error.message : 'unexpected configuration error';
    out.error(`${LOG_PREFIX} ${redact(message)}`);
    return 1;
  }

  const redact = makeRedactor(config.connectionString);
  const say = (line) => out.info(`${LOG_PREFIX} ${redact(line)}`);
  const shout = (line) => out.error(`${LOG_PREFIX} ${redact(line)}`);
  // node-pg-migrate's own messages (migration names, failing SQL, driver errors) pass the redactor.
  // Its connection-failure dump (a full inspect() of the socket error, with resolved addresses) is
  // dropped: the final failure line reports the error code instead.
  const logger = {
    debug: (...args) => say(args.map(redact).join(' ')),
    info: (...args) => say(args.map(redact).join(' ')),
    warn: (...args) => shout(args.map(redact).join(' ')),
    error: (...args) => {
      const line = args.map(redact).join(' ');
      if (!line.startsWith(CONNECT_FAILURE_PREFIX)) shout(line);
    },
  };

  say(`target database "${config.database}"; checking for pending migrations`);
  const options = buildRunnerOptions({ connectionString: config.connectionString, logger, dir });

  for (let attempt = 0; ; attempt += 1) {
    try {
      const applied = await runner(options);
      if (applied.length === 0) {
        say(`no pending migrations (${elapsed()})`);
      } else {
        say(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')} (${elapsed()})`);
      }
      return 0;
    } catch (error) {
      if (isLockBusy(error) && attempt < lockRetries) {
        say(`another deploy holds the migration lock; retry ${attempt + 1}/${lockRetries} in ${lockRetryDelayMs}ms`);
        await sleep(lockRetryDelayMs);
        continue;
      }
      // All pending migrations run in one transaction (singleTransaction), so a failure rolls the
      // whole batch back unless a migration opted out with pgm.noTransaction().
      shout(`failed after ${elapsed()}: ${describeError(error)}`);
      return 1;
    }
  }
}
