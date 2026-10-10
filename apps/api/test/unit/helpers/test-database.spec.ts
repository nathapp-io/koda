import { resolveTestDatabase, type TestDatabase } from '../../helpers/test-database';

const COMPOSE_URL = 'postgresql://koda:koda@localhost:5433/koda_test';
const CONTAINER_URL = 'postgresql://test:test@localhost:55001/koda_test';

function container(): TestDatabase & { stopped: boolean } {
  const db = {
    databaseUrl: CONTAINER_URL,
    source: 'testcontainers' as const,
    stopped: false,
    stop: async () => {
      db.stopped = true;
    },
  };
  return db;
}

describe('resolveTestDatabase', () => {
  it('uses KODA_TEST_DATABASE_URL first, without probing or starting anything', async () => {
    const probe = vi.fn();
    const start = vi.fn();
    const db = await resolveTestDatabase(
      { KODA_TEST_DATABASE_URL: 'postgresql://koda:koda@localhost:6543/koda_test' },
      COMPOSE_URL,
      { probe, start },
    );
    expect(db.databaseUrl).toBe('postgresql://koda:koda@localhost:6543/koda_test');
    expect(db.source).toBe('explicit');
    expect(probe).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('uses the compose test database when it answers', async () => {
    const start = vi.fn();
    const db = await resolveTestDatabase({}, COMPOSE_URL, { probe: async () => true, start });
    expect(db.databaseUrl).toBe(COMPOSE_URL);
    expect(db.source).toBe('compose');
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a Testcontainers Postgres when the compose database is down', async () => {
    const started = container();
    const db = await resolveTestDatabase({}, COMPOSE_URL, {
      probe: async () => false,
      start: async () => started,
    });
    expect(db.databaseUrl).toBe(CONTAINER_URL);
    expect(db.source).toBe('testcontainers');
    await db.stop();
    expect(started.stopped).toBe(true);
  });

  it('skips the compose database when KODA_TEST_DB_CONTAINER=1 asks for a private container', async () => {
    const probe = vi.fn(async () => true);
    const db = await resolveTestDatabase({ KODA_TEST_DB_CONTAINER: '1' }, COMPOSE_URL, {
      probe,
      start: async () => container(),
    });
    expect(db.source).toBe('testcontainers');
    expect(probe).not.toHaveBeenCalled();
  });

  it('starts a container when there is no compose URL at all', async () => {
    const probe = vi.fn();
    const db = await resolveTestDatabase({}, undefined, { probe, start: async () => container() });
    expect(db.source).toBe('testcontainers');
    expect(probe).not.toHaveBeenCalled();
  });

  it('explains both ways out when neither the compose database nor Docker is available', async () => {
    const attempt = resolveTestDatabase({}, COMPOSE_URL, {
      probe: async () => false,
      start: async () => {
        throw new Error('Could not find a working container runtime strategy');
      },
    });
    await expect(attempt).rejects.toThrow(/bun run test:db:up/);
    await expect(attempt).rejects.toThrow(/container runtime/);
  });
});
