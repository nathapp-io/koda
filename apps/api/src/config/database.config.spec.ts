import { databaseConfig, IDatabaseConfig } from './database.config';

describe('databaseConfig', () => {
  beforeEach(() => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/db';
  });

  afterEach(() => {
    delete process.env['DATABASE_URL'];
  });

  it('returns the database url', () => {
    const cfg: IDatabaseConfig = databaseConfig();
    expect(cfg.url).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('does not expose a provider (Postgres is the only provider)', () => {
    const cfg = databaseConfig() as unknown as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('provider');
  });
});
