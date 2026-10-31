import {
  acquireDbRunLock, acquireProcessDbRunLock, releaseRememberedDbRunLock, rememberDbRunLock, type DbLockSession,
} from './db-run-lock';

/**
 * One DB-mode run at a time per test database (fix round 1, F1; fix round 2, B1).
 *
 * Every DB-mode run force-resets the schema in `globalSetup` and every suite truncates all tables, so two runs sharing
 * one Postgres destroy each other. The failure this pins was `expected 201 "Created", got 401 "Unauthorized"` from
 * `AuthService.register`, which re-reads the row it just committed and answers 401 when another process truncated it in
 * between.
 *
 * The lock fails closed (B1): the bug was that contention or a broken session answered "go ahead without the lock", and
 * `globalSetup` — which never looked at that answer — then force-reset a database another live run was using. So every
 * way of not getting the lock now throws, and the setup aborts before the reset. Running unserialised is opt-in only,
 * through `KODA_DB_RUN_LOCK=off` in `globalSetup`.
 *
 * The session is injected so these cases need no database; the Prisma-backed session is thin (lock, unlock, disconnect)
 * and is exercised by running two DB-mode suites at once.
 */
function session(over: Partial<DbLockSession> = {}): DbLockSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tryLock: vi.fn(async (waitMs: number) => { calls.push(`tryLock:${waitMs}`); return over.tryLock === undefined ? true : await over.tryLock(waitMs); }),
    unlock: vi.fn(async () => { calls.push('unlock'); await over.unlock?.(); }),
    close: vi.fn(async () => { calls.push('close'); await over.close?.(); }),
  };
}
const openOf = (value: DbLockSession) => vi.fn(async () => value);

describe('acquireDbRunLock', () => {
  it('owns the lock when the session grants it, and release unlocks then disconnects once', async () => {
    const db = session();
    const lock = await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: openOf(db), waitMs: 1_000,
    });

    expect(db.calls).toEqual(['tryLock:1000']);

    await lock.release();
    await lock.release();
    expect(db.calls).toEqual(['tryLock:1000', 'unlock', 'close']);
  });

  it('aborts the setup when the wait budget expires, after closing the session it could not lock', async () => {
    const db = session({ tryLock: async () => false });

    const attempt = acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: openOf(db), waitMs: 30_000,
    });

    // Throwing — not answering a lock nobody holds — is what keeps `globalSetup` from force-resetting the other run.
    await expect(attempt).rejects.toThrow(/another DB-mode run has held this test database/);
    await expect(attempt).rejects.toThrow(/KODA_DB_RUN_LOCK=off/);
    expect(db.calls).toEqual(['tryLock:30000', 'close']);
  });

  it('aborts the setup when the lock query itself fails, after closing the session', async () => {
    const db = session({ tryLock: async () => { throw new Error('terminating connection due to administrator command'); } });

    const attempt = acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: openOf(db), waitMs: 1_000,
    });

    await expect(attempt).rejects.toThrow(/the test-database lock failed .*administrator command/);
    expect(db.calls).toEqual(['tryLock:1000', 'close']);
  });

  it('aborts the setup when the lock session cannot be opened, rather than resetting a database it cannot lock', async () => {
    const attempt = acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: async () => { throw new Error('connect ECONNREFUSED'); },
    });

    await expect(attempt).rejects.toThrow(/could not open the test-database lock session .*ECONNREFUSED/);
    await expect(attempt).rejects.toThrow(/KODA_DB_RUN_LOCK=off/);
  });

  it('still closes the session when closing it fails during the abort', async () => {
    const db = session({ tryLock: async () => false, close: async () => { throw new Error('close failed'); } });

    await expect(acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: openOf(db), waitMs: 10,
    })).rejects.toThrow(/did not release it/);
    expect(db.calls).toEqual(['tryLock:10', 'close']);
  });

  it('swallows a failing unlock or disconnect: a released gate must not fail on teardown', async () => {
    const db = session({ unlock: async () => { throw new Error('unlock failed'); }, close: async () => { throw new Error('close failed'); } });

    const lock = await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', { openSession: openOf(db) });

    await expect(lock.release()).resolves.toBeUndefined();
    expect(db.calls).toEqual(['tryLock:900000', 'unlock', 'close']);
  });

  it('says so when it had to wait, so a serialised run does not look hung', async () => {
    const db = session({
      tryLock: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return true;
      },
    });
    const log = vi.fn();

    const lock = await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', { openSession: openOf(db), log });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('waited 1s for another DB-mode run'));
    await lock.release();
  });
});

describe('acquireProcessDbRunLock (the per-process entry point Vitest needs)', () => {
  it('takes one lock per database per process, however many global setup runs the projects cause', async () => {
    const db = session();
    const open = openOf(db);
    const url = 'postgresql://koda:koda@localhost:5433/koda_process_test';

    const [first, second] = await Promise.all([
      acquireProcessDbRunLock(url, { openSession: open }),
      acquireProcessDbRunLock(url, { openSession: open }),
    ]);

    expect(open).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    // The other database is a different lock, taken on its own session.
    const other = await acquireProcessDbRunLock('postgresql://koda:koda@localhost:5433/koda_process_other', { openSession: open });
    expect(other).not.toBe(first);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('answers the same failure to a later project instead of letting it retry the force-reset', async () => {
    const url = 'postgresql://koda:koda@localhost:5433/koda_process_contended';
    const open = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });

    const first = acquireProcessDbRunLock(url, { openSession: open });
    const second = acquireProcessDbRunLock(url, { openSession: open });

    await expect(first).rejects.toThrow(/could not open the test-database lock session/);
    await expect(second).rejects.toThrow(/could not open the test-database lock session/);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('remembered lock', () => {
  it('releaseRememberedDbRunLock releases what globalSetup remembered, then forgets it', async () => {
    const db = session();
    rememberDbRunLock(await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', { openSession: openOf(db) }));

    await releaseRememberedDbRunLock();
    await releaseRememberedDbRunLock();

    expect(db.calls).toEqual(['tryLock:900000', 'unlock', 'close']);
  });

  it('is a no-op when globalSetup remembered nothing', async () => {
    await expect(releaseRememberedDbRunLock()).resolves.toBeUndefined();
  });
});
