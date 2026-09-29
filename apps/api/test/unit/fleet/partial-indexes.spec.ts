import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PARTIAL_UNIQUE_INDEXES } from '../../helpers/partial-indexes';

describe('partial unique indexes', () => {
  const dir = join(__dirname, '../../../prisma/migrations');
  const allSql = readdirSync(dir)
    .filter((name) => /^\d{14}_/.test(name))
    .map((name) => readFileSync(join(dir, name, 'migration.sql'), 'utf8'))
    .join('\n');

  it.each(PARTIAL_UNIQUE_INDEXES.map((sql) => [sql]))('is shipped verbatim by a migration: %s', (sql) => {
    // Tests build the schema with `prisma db push`, which cannot express partial indexes;
    // global-setup replays these statements, so they must equal what production migrates.
    expect(allSql).toContain(sql);
  });
});
