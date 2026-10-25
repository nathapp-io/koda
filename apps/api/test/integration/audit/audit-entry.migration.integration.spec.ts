import { canRunDbTests } from '../../helpers/test-environment';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const describeDb = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261103090000_audit_entry';
describeDb('AuditEntry migration (PG)', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'audit_entry_migration', MIGRATION);
    await applyMigration(scratch.db, MIGRATION);
  }, 30_000);
  afterAll(async () => { await scratch?.drop(); });
  it('creates all columns and exactly the intended secondary indexes', async () => {
    const columns = await scratch.db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'audit_entry_migration' AND table_name = 'AuditEntry' ORDER BY ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['id','key','resourceType','resourceId','projectId','actorType','actorId','onBehalfOfType','onBehalfOfId','origin','requiredMode','satisfiedBy','approverType','approverId','approvalRequestId','correlationId','summary','createdAt']);
    const indexes = await scratch.db.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'audit_entry_migration' AND tablename = 'AuditEntry' AND indexname <> 'AuditEntry_pkey' ORDER BY indexname`,
    );
    expect(indexes.map((x) => x.indexdef.match(/USING btree \((.*?)\)/)?.[1].replaceAll('"', ''))).toEqual(['actorId, createdAt','actorType','approverId','createdAt','key','projectId, createdAt','resourceType, resourceId'].sort());
  });
});

/**
 * Permissions P2 US-002 — the correlation filter is an equality match on `correlationId` over an
 * append-only log, so the column needs its own index; without one the page degrades to a full scan.
 * One case pins the migration, the other pins the schema `prisma db push` builds from schema.prisma,
 * so the two cannot drift apart.
 */
const CORRELATION_INDEX_MIGRATION = '20261103090100_audit_correlation_index';

describeDb('AuditEntry correlationId index (PG)', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'audit_correlation_index', CORRELATION_INDEX_MIGRATION);
    await applyMigration(scratch.db, CORRELATION_INDEX_MIGRATION);
  }, 60_000);
  afterAll(async () => { await scratch?.drop(); });

  it('ships the (correlationId, createdAt) index in the migration', async () => {
    const indexes = await scratch.db.$queryRawUnsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'audit_correlation_index' AND tablename = 'AuditEntry' AND indexname = 'AuditEntry_correlationId_createdAt_idx'`,
    );
    expect(indexes.map((x) => x.indexdef.match(/USING btree \((.*?)\)/)?.[1].replaceAll('"', ''))).toEqual(['correlationId, createdAt']);
  });
});

describeDb('AuditEntry correlationId index in the pushed schema (PG)', () => {
  it('declares the same index schema.prisma builds', async () => {
    const db = createTestPrismaClient();
    try {
      const indexes = await db.$queryRawUnsafe<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'AuditEntry' AND indexname = 'AuditEntry_correlationId_createdAt_idx'`,
      );
      expect(indexes.map((row) => row.indexname)).toEqual(['AuditEntry_correlationId_createdAt_idx']);
    } finally {
      await db.$disconnect();
    }
  });
});
