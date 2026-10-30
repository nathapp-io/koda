import { restoreEnvAfterEach } from '../src/common/test-helpers/restore-env';

/**
 * `globalSetup` must not force-reset a test database it could not lock (fix round 2, B1).
 *
 * The helper used to answer "go ahead without the lock" on contention and on a broken session, and this setup never
 * looked at that answer: it went straight into `prisma db push --force-reset`, erasing the fixtures of the run holding
 * the database. `acquireDbRunLock` now throws instead, and this spec pins that the setup lets that failure through —
 * before any reset, after stopping a container it started — and that `KODA_DB_RUN_LOCK=off` stays the only
 * unserialised path.
 */
const mocks = vi.hoisted(() => ({
  canRunDbTests: vi.fn(() => true),
  resolveTestDatabase: vi.fn(),
  rememberTestDatabase: vi.fn(),
  acquireProcessDbRunLock: vi.fn(),
  rememberDbRunLock: vi.fn(),
  releaseRememberedDbRunLock: vi.fn(async () => undefined),
  prepareSchemaOnce: vi.fn(async () => undefined),
}));

vi.mock('./helpers/test-environment', () => ({ canRunDbTests: mocks.canRunDbTests }));
vi.mock('./helpers/test-database', () => ({
  resolveTestDatabase: mocks.resolveTestDatabase,
  rememberTestDatabase: mocks.rememberTestDatabase,
}));
vi.mock('./helpers/db-run-lock', () => ({
  acquireProcessDbRunLock: mocks.acquireProcessDbRunLock,
  rememberDbRunLock: mocks.rememberDbRunLock,
  releaseRememberedDbRunLock: mocks.releaseRememberedDbRunLock,
}));
vi.mock('./helpers/schema-once', () => ({ prepareSchemaOnce: mocks.prepareSchemaOnce }));
// `globalSetup` loads `.env.test` with `override`; keep the real parser (the compose URL is read from the file) and stop
// the load from rewriting this worker's environment.
vi.mock('dotenv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dotenv')>();
  return { ...actual, config: vi.fn(() => ({ parsed: {} })) };
});

import globalSetup from './global-setup';

const DATABASE_URL = 'postgresql://koda:koda@localhost:5433/koda_test';

function database(source: 'compose' | 'testcontainers' = 'compose') {
  return { databaseUrl: DATABASE_URL, source, stop: vi.fn(async () => undefined) };
}

describe('globalSetup (DB mode)', () => {
  restoreEnvAfterEach();

  let db: ReturnType<typeof database>;
  let lock: { release: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    db = database();
    lock = { release: vi.fn(async () => undefined) };
    delete process.env['KODA_DB_RUN_LOCK'];
    // Re-applied per test, not only cleared: a case that changes a default (DB mode off) must not leak to the next one.
    mocks.canRunDbTests.mockReturnValue(true);
    mocks.resolveTestDatabase.mockResolvedValue(db);
    mocks.acquireProcessDbRunLock.mockResolvedValue(lock);
  });

  it('runs the force-reset under the lock it took, and lets globalTeardown release it', async () => {
    await globalSetup();

    expect(mocks.acquireProcessDbRunLock).toHaveBeenCalledWith(DATABASE_URL, expect.objectContaining({ log: expect.any(Function) }));
    expect(mocks.rememberDbRunLock).toHaveBeenCalledWith(lock);
    expect(mocks.prepareSchemaOnce).toHaveBeenCalledWith(DATABASE_URL, expect.any(Function));
    expect(db.stop).not.toHaveBeenCalled();
  });

  it('aborts before the force-reset when another DB-mode run holds the database', async () => {
    mocks.acquireProcessDbRunLock.mockRejectedValue(new Error('koda: another DB-mode run has held this test database for 900s'));

    await expect(globalSetup()).rejects.toThrow(/another DB-mode run has held this test database/);

    // The reset is the destructive part: it must never run behind a lock this setup does not hold.
    expect(mocks.prepareSchemaOnce).not.toHaveBeenCalled();
    expect(mocks.rememberDbRunLock).not.toHaveBeenCalled();
  });

  it('aborts the same way when the lock session cannot be opened, and stops a container it started', async () => {
    db = database('testcontainers');
    mocks.resolveTestDatabase.mockResolvedValue(db);
    mocks.acquireProcessDbRunLock.mockRejectedValue(new Error('koda: could not open the test-database lock session'));

    await expect(globalSetup()).rejects.toThrow(/could not open the test-database lock session/);

    expect(mocks.prepareSchemaOnce).not.toHaveBeenCalled();
    // globalTeardown does not run when globalSetup throws, so the setup cleans up after itself.
    expect(mocks.releaseRememberedDbRunLock).toHaveBeenCalled();
    expect(db.stop).toHaveBeenCalledTimes(1);
  });

  it('runs unserialised only when KODA_DB_RUN_LOCK=off says the database is nobody else’s', async () => {
    process.env['KODA_DB_RUN_LOCK'] = 'off';

    await globalSetup();

    expect(mocks.acquireProcessDbRunLock).not.toHaveBeenCalled();
    expect(mocks.rememberDbRunLock).not.toHaveBeenCalled();
    expect(mocks.prepareSchemaOnce).toHaveBeenCalledWith(DATABASE_URL, expect.any(Function));
  });

  it('touches no database outside DB mode', async () => {
    mocks.canRunDbTests.mockReturnValue(false);

    await globalSetup();

    expect(mocks.resolveTestDatabase).not.toHaveBeenCalled();
    expect(mocks.acquireProcessDbRunLock).not.toHaveBeenCalled();
    expect(mocks.prepareSchemaOnce).not.toHaveBeenCalled();
  });
});
