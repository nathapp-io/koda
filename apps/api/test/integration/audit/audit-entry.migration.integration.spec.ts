import { canRunDbTests } from '../../helpers/test-environment';
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
    expect(indexes.map((x) => x.indexdef.match(/USING btree \((.*?)\)/)?.[1].replaceAll('"', '')).toEqual(['actorId, createdAt','actorType','approverId','createdAt','key','projectId, createdAt','resourceType, resourceId'].sort());
  });
});
