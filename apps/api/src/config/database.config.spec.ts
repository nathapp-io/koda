import { databaseConfig, IDatabaseConfig } from './database.config';

describe('databaseConfig', () => {
  beforeEach(() => {
    process.env['DATABASE_URL'] = 'file:./test.db';
    delete process.env['DATABASE_PROVIDER'];
  });

  afterEach(() => {
    delete process.env['DATABASE_URL'];
  });

  it('returns typed IDatabaseConfig with defaults', () => {
    const cfg: IDatabaseConfig = databaseConfig();
    expect(cfg.url).toBe('file:./test.db');
    expect(cfg.provider).toBe('sqlite');
  });
});
