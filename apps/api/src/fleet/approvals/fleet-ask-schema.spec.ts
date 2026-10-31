import { readFileSync } from 'fs';
import { join } from 'path';

const migration = '20261110090000_fleet_ask_drop_published_status';

describe('fleet ask publication retirement', () => {
  it('AC-4: ships a column-drop migration and keeps only the activity marker in the schema', () => {
    const root = join(__dirname, '../../..');
    const sql = readFileSync(join(root, 'prisma/migrations', migration, 'migration.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE "FleetApprovalAsk" DROP COLUMN "publishedStatus";/);
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model FleetApprovalAsk \{([\s\S]*?)\n\}/)?.[1];
    expect(model).toBeDefined();
    expect(model).not.toContain('publishedStatus');
    expect(model).toContain('recordedStatus');
  });
});
