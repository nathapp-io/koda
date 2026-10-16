/**
 * US-001 AC-12, without a database: the workspace migration must ship the index the schema declares, with the
 * columns in the order a `(createdById, kind, lastActivityAt)` lookup needs, and sort after every migration that
 * precedes it so `migrationsBefore` replays the whole chain before it is applied.
 *
 * The DB-level half of AC-12 (the index exists after applying the migration) lives in
 * test/integration/fleet/fleet-thread-workspace-migration.integration.spec.ts, which needs Postgres.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { migrationStatements, migrationsBefore } from '../../helpers/migration-schema';

const MIGRATION = '20261022090000_chat_thread_workspace';
const LATEST_BEFORE = '20261021091000_knowledge_project_patterns';
const INDEX = 'ChatThread_createdById_kind_lastActivityAt_idx';

/** The statement creating the workspace index, if the migration has one. */
const createIndexStatement = (): string | undefined =>
  migrationStatements(MIGRATION).find((statement) => statement.includes(`INDEX "${INDEX}"`));

/** The quoted column list of a CREATE INDEX statement, in written order. */
const columnsOf = (statement: string): string[] => {
  const list = statement.match(/\(([^()]*)\)\s*$/)?.[1];
  return (list ?? '').split(',').map((column) => column.trim().replace(/"/g, '')).filter((column) => column.length > 0);
};

describe('ChatThread workspace migration (US-001 AC-12)', () => {
  it('AC-12: ships a statement creating ChatThread_createdById_kind_lastActivityAt_idx on ChatThread', () => {
    const statement = createIndexStatement();
    expect(statement).toBeDefined();
    expect(statement).toMatch(/ON\s+"ChatThread"/);
  });

  it('AC-12: the index covers createdById, kind and lastActivityAt in that order', () => {
    const statement = createIndexStatement() ?? '';
    expect(columnsOf(statement)).toEqual(['createdById', 'kind', 'lastActivityAt']);
  });

  it('sorts after every committed migration, so the scratch schema is built by them first', () => {
    expect(migrationStatements(MIGRATION).length).toBeGreaterThan(0);
    expect(migrationsBefore(MIGRATION).at(-1)).toBe(LATEST_BEFORE);
  });

  it('matches the Prisma schema, which `prisma db push` builds the test schema from', () => {
    const schema = readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model ChatThread {'));
    const body = model.slice(0, model.indexOf('\n}'));
    expect(body).toContain('// REPO | PROJECT | WORKSPACE');
    expect(body).toContain('@@index([createdById, kind, lastActivityAt])');
  });
});
