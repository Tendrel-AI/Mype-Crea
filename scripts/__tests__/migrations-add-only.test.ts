import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADD_ONLY_BASELINE,
  checkMigration,
  extractUpBody,
  isGrandfathered,
} from '../migration-add-only.mjs';

const MIGRATIONS = path.resolve(__dirname, '..', '..', 'migrations');
const NEW = '1792900000000_example.js';

function migration(up: string, down = "pgm.sql('SELECT 1');", header = '') {
  return `${header}\nexport const shorthands = undefined;\n\nexport const up = (pgm) => {\n  ${up}\n};\n\nexport const down = (pgm) => {\n  ${down}\n};\n`;
}

describe('add-only rule over migrations/', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.js')).sort();

  it('finds the grandfathered baseline file', () => {
    expect(files.some((f) => f.startsWith(`${ADD_ONLY_BASELINE}_`))).toBe(true);
  });

  it('every migration newer than the baseline is add-only or carries a destructive-ok marker', () => {
    const problems = files.flatMap((f) => checkMigration(f, readFileSync(path.join(MIGRATIONS, f), 'utf8')));
    expect(problems).toEqual([]);
  });
});

describe('checkMigration', () => {
  it.each([
    ['CREATE TABLE', "pgm.sql('CREATE TABLE app.things (id uuid PRIMARY KEY)');"],
    ['ADD COLUMN', "pgm.sql('ALTER TABLE app.things ADD COLUMN note text');"],
    ['CREATE OR REPLACE FUNCTION', "pgm.sql('CREATE OR REPLACE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');"],
    ['CREATE POLICY and GRANT', "pgm.sql('CREATE POLICY p ON app.things USING (true); GRANT SELECT ON app.things TO app_user');"],
    ['DROP CONSTRAINT (loosening)', "pgm.sql('ALTER TABLE app.things DROP CONSTRAINT things_check');"],
    ['DROP NOT NULL (loosening)', "pgm.sql('ALTER TABLE app.things ALTER COLUMN note DROP NOT NULL');"],
    ['ALTER TYPE ... ADD VALUE', "pgm.sql(\"ALTER TYPE deliverable_kind ADD VALUE 'brochure'\");"],
    ['builder createTable/addColumns', "pgm.createTable('things', { id: 'uuid' }); pgm.addColumns('things', { a: 'text' });"],
    ['destructive words only in comments', "// DROP TABLE later\n  pgm.sql(`\n    -- RENAME in a later deploy\n    CREATE TABLE x (id int) -- not DROP TABLE\n  `);"],
  ])('passes an add-only up: %s', (_label, up) => {
    expect(checkMigration(NEW, migration(up))).toEqual([]);
  });

  it.each([
    ['DROP TABLE', "pgm.sql('DROP TABLE app.things');", /DROP of a schema object/],
    ['DROP COLUMN', "pgm.sql('ALTER TABLE app.things DROP COLUMN note');", /DROP/],
    ['bare ALTER TABLE ... DROP column', "pgm.sql('ALTER TABLE app.things DROP note');", /ALTER TABLE \.\.\. DROP/],
    ['DROP DEFAULT', "pgm.sql('ALTER TABLE app.things ALTER COLUMN note DROP DEFAULT');", /ALTER TABLE \.\.\. DROP/],
    ['DROP FUNCTION', "pgm.sql('DROP FUNCTION IF EXISTS app.f()');", /DROP of a schema object/],
    ['DROP POLICY', "pgm.sql('DROP POLICY p ON app.things');", /DROP of a schema object/],
    ['DROP TRIGGER', "pgm.sql('DROP TRIGGER IF EXISTS t ON app.things');", /DROP of a schema object/],
    ['DROP TYPE', "pgm.sql('DROP TYPE app.kind');", /DROP of a schema object/],
    ['RENAME TABLE', "pgm.sql('ALTER TABLE app.things RENAME TO stuff');", /RENAME/],
    ['RENAME COLUMN', "pgm.sql('ALTER TABLE app.things RENAME COLUMN a TO b');", /RENAME/],
    ['ALTER COLUMN TYPE', "pgm.sql('ALTER TABLE app.things ALTER COLUMN note TYPE varchar(10)');", /ALTER COLUMN \.\.\. TYPE/],
    ['ALTER COLUMN SET DATA TYPE', "pgm.sql('ALTER TABLE app.things ALTER COLUMN note SET DATA TYPE int USING 0');", /ALTER COLUMN \.\.\. TYPE/],
    ['ALTER without COLUMN keyword TYPE', 'pgm.sql(\'ALTER TABLE app.things ALTER "note" TYPE int\');', /ALTER COLUMN \.\.\. TYPE/],
    ['SET NOT NULL', "pgm.sql('ALTER TABLE app.things ALTER COLUMN note SET NOT NULL');", /SET NOT NULL/],
    ['TRUNCATE', "pgm.sql('TRUNCATE app.things');", /TRUNCATE/],
    ['builder dropTable', "pgm.dropTable('things');", /MigrationBuilder/],
    ['builder renameColumn', "pgm.renameColumn('things', 'a', 'b');", /MigrationBuilder/],
    ['builder alterColumn', "pgm.alterColumn('things', 'a', { notNull: true });", /MigrationBuilder/],
    ['lowercase SQL', "pgm.sql('drop table app.things');", /DROP of a schema object/],
  ])('fails a destructive up: %s', (_label, up, expected) => {
    const problems = checkMigration(NEW, migration(up));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(expected);
    expect(problems[0]).toMatch(/destructive-ok: <reason>/);
  });

  it('exempts down: a reversible add-only migration may drop in down', () => {
    expect(checkMigration(NEW, migration("pgm.sql('CREATE TABLE x (id int)');", "pgm.sql('DROP TABLE x');"))).toEqual([]);
  });

  it('accepts a destructive up when the file carries the marker with a reason', () => {
    const source = migration("pgm.sql('ALTER TABLE app.things DROP COLUMN note');", undefined, '// destructive-ok: note unused since KAN-99 deploy');
    expect(checkMigration(NEW, source)).toEqual([]);
  });

  it('rejects a marker without a reason', () => {
    const source = migration("pgm.sql('DROP TABLE x');", undefined, '// destructive-ok:');
    expect(checkMigration(NEW, source)).not.toEqual([]);
  });

  it('grandfathers files at or before the baseline', () => {
    expect(isGrandfathered(`${ADD_ONLY_BASELINE}_approval-owner-only.js`)).toBe(true);
    expect(checkMigration(`${ADD_ONLY_BASELINE - 1}_old.js`, migration("pgm.sql('DROP TABLE x');"))).toEqual([]);
    expect(checkMigration(`${ADD_ONLY_BASELINE + 1}_new.js`, migration("pgm.sql('DROP TABLE x');"))).not.toEqual([]);
  });

  it('fails a new file without an up export or a timestamped name', () => {
    expect(checkMigration(NEW, 'export const down = () => {};')).toEqual([`${NEW}: no \`up\` export found`]);
    expect(checkMigration('example.js', migration('pgm.sql("SELECT 1");'))).toHaveLength(1);
  });

  it('extracts up when down is declared first', () => {
    const source = "export const down = (pgm) => { pgm.sql('DROP TABLE x'); };\nexport const up = (pgm) => { pgm.sql('CREATE TABLE x (id int)'); };";
    expect(extractUpBody(source)).toContain('CREATE TABLE x');
    expect(extractUpBody(source)).not.toContain('DROP TABLE');
  });
});
