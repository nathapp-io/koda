/**
 * Track 1 slice 2: the OutboxEvent reshape migration rewrites legacy rows.
 * Applies the init migration and the slice-2 migration to a scratch schema.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- outbox-migration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const MIGRATIONS_DIR = join(__dirname, '../../../prisma/migrations');
const INIT = '20260925151610_init';
const SLICE_2 = '20260926090000_outbox_nestjs_outbox';
const SCHEMA = 'outbox_migration_test';

/** Migration SQL → statements. Comment lines are dropped first; no statement contains a literal ';'. */
function statements(migration: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function withSchema(url: string, schema: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

interface MigratedRow {
  id: string;
  type: string;
  status: string;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  leaseUntil: Date | null;
  owner: string | null;
}

describeIntegration('OutboxEvent slice-2 migration', () => {
  const baseUrl = process.env.DATABASE_URL as string;
  let admin: PrismaClient;
  let db: PrismaClient;
  const before = new Date();

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);

    db = new PrismaClient({ datasources: { db: { url: withSchema(baseUrl, SCHEMA) } } });
    for (const sql of statements(INIT)) {
      await db.$executeRawUnsafe(sql);
    }

    await db.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', CURRENT_TIMESTAMP)`,
    );
    // Legacy shapes the old processor could leave behind.
    await db.$executeRawUnsafe(`
      INSERT INTO "OutboxEvent" ("id", "projectId", "eventType", "eventId", "payload", "status", "attempts", "nextAttemptAt", "processedAt", "updatedAt") VALUES
        ('done',    'p1', 'ticket_event', 'e1', '{}', 'completed',   1, NULL, '2026-09-01 00:00:00', CURRENT_TIMESTAMP),
        ('dead',    'p1', 'ticket_event', 'e2', '{}', 'dead_letter', 3, NULL, NULL,                  CURRENT_TIMESTAMP),
        ('failed',  'p1', 'code_commit',  'e3', '{}', 'failed',      1, '2099-01-01 00:00:00', NULL, CURRENT_TIMESTAMP),
        ('stuck',   'p1', 'ticket_event', 'e4', '{}', 'processing',  0, NULL, NULL,                  CURRENT_TIMESTAMP),
        ('waiting', 'p1', 'agent_event',  'e5', '{}', 'pending',     0, NULL, NULL,                  CURRENT_TIMESTAMP)
    `);

    for (const sql of statements(SLICE_2)) {
      await db.$executeRawUnsafe(sql);
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin?.$disconnect();
  });

  const row = async (id: string): Promise<MigratedRow> => {
    const rows = await db.$queryRawUnsafe<MigratedRow[]>(
      `SELECT "id", "type", "status", "nextAttemptAt", "publishedAt", "leaseUntil", "owner" FROM "OutboxEvent" WHERE "id" = $1`,
      id,
    );
    return rows[0];
  };

  it('renames eventType to type and processedAt to publishedAt, keeping values', async () => {
    const done = await row('done');
    expect(done.type).toBe('ticket_event');
    expect(done.publishedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });

  it('maps completed to published and dead_letter to dead', async () => {
    expect((await row('done')).status).toBe('published');
    expect((await row('dead')).status).toBe('dead');
  });

  it('requeues failed rows immediately, even with a far-future nextAttemptAt', async () => {
    const failed = await row('failed');
    expect(failed.status).toBe('pending');
    expect(failed.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000);
  });

  it('requeues lease-less processing rows so the new claim query can reach them', async () => {
    const stuck = await row('stuck');
    expect(stuck.status).toBe('pending');
    expect(stuck.leaseUntil).toBeNull();
    expect(stuck.owner).toBeNull();
    expect(stuck.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('backfills a null nextAttemptAt so pending rows stay claimable', async () => {
    const waiting = await row('waiting');
    expect(waiting.status).toBe('pending');
    expect(waiting.nextAttemptAt).not.toBeNull();
    expect(waiting.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('makes nextAttemptAt NOT NULL and adds headers, leaseUntil and owner', async () => {
    const columns = await db.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'OutboxEvent'`,
      SCHEMA,
    );
    const byName = new Map(columns.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.get('nextAttemptAt')).toBe('NO');
    expect(byName.has('headers')).toBe(true);
    expect(byName.has('leaseUntil')).toBe(true);
    expect(byName.has('owner')).toBe(true);
    expect(byName.has('eventType')).toBe(false);
    expect(byName.has('processedAt')).toBe(false);
  });
});
