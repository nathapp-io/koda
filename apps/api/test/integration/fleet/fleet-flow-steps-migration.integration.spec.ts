import { randomUUID } from 'node:crypto';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { canRunDbTests } from '../../helpers/test-environment';

const MIGRATION = '20261128090000_fleet_flow_steps';
const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('fleet flow steps migration', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Test database URL missing');
    scratch = await scratchSchemaBefore(url, `flow_steps_${randomUUID().replaceAll('-', '')}`, MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  it('adds nullable linkage/detail columns, lookup indexes and SET NULL foreign key', async () => {
    await applyMigration(scratch.db, MIGRATION);
    const columns = await scratch.db.$queryRaw<Array<{ table_name: string; column_name: string; is_nullable: string }>>`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND
        ((table_name = 'FleetJob' AND column_name IN ('flowId', 'flowStep')) OR
         (table_name = 'FleetFlow' AND column_name = 'stopDetail'))`;
    expect(columns).toEqual(expect.arrayContaining([
      { table_name: 'FleetJob', column_name: 'flowId', is_nullable: 'YES' },
      { table_name: 'FleetJob', column_name: 'flowStep', is_nullable: 'YES' },
      { table_name: 'FleetFlow', column_name: 'stopDetail', is_nullable: 'YES' },
    ]));
    const indexes = await scratch.db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
        AND indexname IN ('FleetJob_flowId_queuedAt_idx', 'FleetFlow_state_id_idx')`;
    expect(indexes.map(({ indexname }) => indexname).sort()).toEqual(['FleetFlow_state_id_idx', 'FleetJob_flowId_queuedAt_idx']);
    const foreignKey = await scratch.db.$queryRaw<Array<{ delete_action: string }>>`
      SELECT c.confdeltype::text AS delete_action FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'FleetJob_flowId_fkey' AND n.nspname = current_schema()`;
    expect(foreignKey).toEqual([{ delete_action: 'n' }]);
  });
});
