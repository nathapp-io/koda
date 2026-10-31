import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261110090000_fleet_ask_drop_published_status';

integration('fleet ask publication marker migration', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'fleet_ask_publication_drop', MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  it('AC-4: drops publishedStatus while retaining recordedStatus after migrations', async () => {
    const columns = () => scratch.db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'FleetApprovalAsk'`,
    );
    expect((await columns()).map(c => c.column_name)).toContain('publishedStatus');
    await applyMigration(scratch.db, MIGRATION);
    const names = (await columns()).map(c => c.column_name);
    expect(names).not.toContain('publishedStatus');
    expect(names).toContain('recordedStatus');
  });
});
