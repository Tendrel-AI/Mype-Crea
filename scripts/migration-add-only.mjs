// Add-only rule for migrations (KAN-83). Migrations apply automatically before the new version
// starts, while the previous version is still serving, so a migration's `up` must stay compatible
// with the code already running: it may add tables, columns, functions, policies and triggers.
// Destructive or renaming changes ship in a LATER deploy, once no running version needs the old
// shape, and the file must say so with a marker comment:
//
//   // destructive-ok: <reason>
//
// The check is a deliberately simple text scan of the `up` body (comments stripped). `down` is
// exempt. False positives are expected (for example `DROP TRIGGER IF EXISTS` before re-creating a
// trigger); the marker is the escape hatch. Files at or before ADD_ONLY_BASELINE are grandfathered.
// Enforced by scripts/__tests__/migrations-add-only.test.ts.

/** Timestamp of the newest migration when the rule was introduced; older files are not scanned. */
export const ADD_ONLY_BASELINE = 1792800002400;

export const DESTRUCTIVE_MARKER = /\/\/[ \t]*destructive-ok:[ \t]*\S/;

const NOT_A_COLUMN =
  'TABLE|TYPE|DOMAIN|FUNCTION|POLICY|ROLE|SCHEMA|SEQUENCE|VIEW|INDEX|TRIGGER|DATABASE|DEFAULT|EXTENSION|MATERIALIZED|PROCEDURE|CONSTRAINT';

/** Each rule: a label for the failure message and a case-insensitive pattern. */
export const DESTRUCTIVE_RULES = [
  {
    label: 'DROP of a schema object',
    pattern:
      /\bDROP\s+(?:TABLE|COLUMN|FUNCTION|PROCEDURE|POLICY|TRIGGER|TYPE|VIEW|MATERIALIZED\s+VIEW|SCHEMA|SEQUENCE|DOMAIN|EXTENSION)\b/i,
  },
  {
    // ALTER TABLE t DROP [COLUMN] c / DROP DEFAULT / DROP IDENTITY; DROP CONSTRAINT and
    // DROP NOT NULL only loosen rules and are allowed.
    label: 'ALTER TABLE ... DROP',
    pattern: /\bALTER\s+TABLE\b[^;]*?\bDROP\s+(?!CONSTRAINT\b|NOT\s+NULL\b)/i,
  },
  { label: 'RENAME', pattern: /\bRENAME\b/i },
  {
    label: 'ALTER COLUMN ... TYPE',
    pattern: new RegExp(
      `\\bALTER\\s+(?:COLUMN\\s+)?(?!(?:${NOT_A_COLUMN})\\b)(?:"[^"]+"|\\w+)\\s+(?:SET\\s+DATA\\s+)?TYPE\\b`,
      'i',
    ),
  },
  { label: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
  { label: 'TRUNCATE', pattern: /\bTRUNCATE\b/i },
  {
    label: 'destructive MigrationBuilder call',
    pattern: /\bpgm\s*\.\s*(?:drop(?!Constraint\b|Index\b)\w+|rename\w+|alterColumn)\s*\(/,
  },
];

/** Removes block comments and whole-line `//` / `--` comments so prose does not trip the scan. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|--)/.test(line))
    .map((line) => line.replace(/\s--\s.*$/, ''))
    .join('\n');
}

const UP_START = /\bexport\s+(?:const\s+up\b|(?:async\s+)?function\s+up\b)|\bexports\.up\s*=/;
const DOWN_START = /\bexport\s+(?:const\s+down\b|(?:async\s+)?function\s+down\b)|\bexports\.down\s*=/;

/**
 * Returns the source text of the `up` export (up to the `down` export when it follows), or null
 * when no `up` export is found.
 */
export function extractUpBody(source) {
  const up = UP_START.exec(source);
  if (!up) return null;
  const rest = source.slice(up.index);
  const down = DOWN_START.exec(rest);
  return down ? rest.slice(0, down.index) : rest;
}

export function migrationTimestamp(fileName) {
  const match = /^(\d+)_/.exec(fileName);
  return match ? Number(match[1]) : null;
}

export function isGrandfathered(fileName) {
  const ts = migrationTimestamp(fileName);
  return ts !== null && ts <= ADD_ONLY_BASELINE;
}

/**
 * Checks one migration file. Returns a list of human-readable problems (empty = passes).
 *
 * @param {string} fileName
 * @param {string} source
 * @returns {string[]}
 */
export function checkMigration(fileName, source) {
  if (isGrandfathered(fileName)) return [];
  if (migrationTimestamp(fileName) === null) {
    return [`${fileName}: name must start with "<timestamp>_"`];
  }
  if (DESTRUCTIVE_MARKER.test(source)) return [];
  const up = extractUpBody(source);
  if (up === null) return [`${fileName}: no \`up\` export found`];
  const body = stripComments(up);
  return DESTRUCTIVE_RULES.filter((rule) => rule.pattern.test(body)).map(
    (rule) =>
      `${fileName}: ${rule.label} in up. Migrations must be add-only; ship it in a later deploy and add "// destructive-ok: <reason>" to the file.`,
  );
}
