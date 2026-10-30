import {
  acquireDbRunLock, acquireProcessDbRunLock, releaseRememberedDbRunLock, rememberDbRunLock, type DbLockSession,
} from './db-run-lock';

/**
 * One DB-mode run at a time per test database (fix round 1, F1).
 *
 * Every DB-mode run force-resets the schema in `globalSetup` and every suite truncates all tables, so two runs sharing
 * one Postgres destroy each other. The failure this pins was `expected 201 "Created", got 401 "Unauthorized"` from
 * `AuthService.register`, which re-reads the row it just committed and answers 401 when another process truncated it in
 * between.
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
    expect(lock.ownsLock).toBe(true);

    await lock.release();
    await lock.release();
    expect(db.calls).toEqual(['tryLock:1000', 'unlock', 'close']);
  });

  it('goes ahead without the lock when the wait budget expires, and never unlocks a lock it does not hold', async () => {
    const db = session({ tryLock: async () => false });
    const log = vi.fn();

    const lock = await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: openOf(db), waitMs: 30_000, log,
    });

    expect(lock.ownsLock).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('another DB-mode run'));
    await lock.release();
    expect(db.calls).toEqual(['tryLock:30000', 'close']);
  });

  it('is a no-op when the database cannot be reached, so the specs fail with their own error', async () => {
    const log = vi.fn();

    const lock = await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', {
      openSession: async () => { throw new Error('connect ECONNREFUSED'); },
      log,
    });

    expect(lock.ownsLock).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('swallows a failing unlock or disconnect: a released gate must not fail on teardown', async () => {
    const db = session({ unlock: async () => { throw new Error('unlock failed'); }, close: async () => { throw new Error('close failed'); } });

    const lock = await acquireDbRunLock('postgresql://koda:koda@localhost:5433/koda_test', { openSession: openOf(db) });

    await expect(lock.release()).resolves.toBeUndefined();
    expect(db.calls).toEqual(['tryLock:900000', 'unlock', 'close']);
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
