/**
 * One DB-mode run at a time per test database (fix round 1, F1; fails closed since fix round 2, B1).
 *
 * Every DB-mode run force-resets the schema in `globalSetup` (`prisma db push --force-reset`) and every suite's
 * `beforeAll` truncates all tables, so two runs sharing one Postgres destroy each other. The repo rule already says so
 * ("do not run two DB-mode test runs against the same database at once"); this lock enforces it for every run that goes
 * through `globalSetup` instead of leaving the collision to chance.
 *
 * The damage it prevents is concrete: `AuthService.register` commits the user row and then re-reads it to issue the
 * session, so a truncate landing in that window makes registration answer `401` — which is the fleet fixture's very
 * first call — and whole suites then fail in `beforeAll` with no structured failure to report.
 *
 * The lock is a Postgres **advisory lock**, taken on a connection of its own and held for the whole run:
 *
 * - it is granted by the database, so there is no stale-file or reused-pid failure mode: the lock disappears the moment
 *   the holding connection ends, which is exactly when a killed run stops mattering;
 * - a second run polls `pg_try_advisory_lock` until the first finishes, with `waitMs` as its budget: once the budget
 *   expires — or the session cannot even be opened — this helper **throws** and the setup aborts, because the next thing
 *   `globalSetup` does is `prisma db push --force-reset`, which would erase the fixtures of the run it could not see.
 *   Failing closed is the whole point of the lock; an unserialised run is opt-in only, through `KODA_DB_RUN_LOCK=off`;
 * - the unlock is best-effort: a released green run must never fail on teardown.
 */
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { pgAdapterConfig } from '../../src/prisma/pg-adapter';

const DEFAULT_WAIT_MS = 15 * 60_000;
/** How often a waiting run retries the advisory lock. */
const POLL_MS = 500;
/** How long a wait has to last before the run says it is waiting for another one. */
const WAIT_NOTICE_MS = 1_000;

/** One lock session: the unit cases inject a double instead of opening a connection. */
export interface DbLockSession {
  /** Blocks until the lock is granted; answers false when the wait budget ran out. */
  tryLock(waitMs: number): Promise<boolean>;
  unlock(): Promise<void>;
  close(): Promise<void>;
}

export interface DbRunLock {
  release(): Promise<void>;
}

export interface AcquireDbRunLockOptions {
  /** Total time to wait for another run before aborting the setup. */
  waitMs?: number;
  log?: (message: string) => void;
  /** Test seam: how to open the session. */
  openSession?: (databaseUrl: string) => Promise<DbLockSession>;
}

/** A 63-bit advisory-lock key for one database (host + schema, never the credentials). */
export function dbRunLockKey(databaseUrl: string): bigint {
  let key = databaseUrl;
  try {
    const url = new URL(databaseUrl);
    key = `${url.host}${url.pathname}`;
  } catch {
    // Not a URL: key on the whole string rather than share one lock with every other malformed value.
  }
  return BigInt(`0x${createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 15)}`);
}

/**
 * The advisory-lock session: its own Prisma client with a one-connection pool that never idles out, so the backend
 * holding the lock stays connected for the run. It does not go through `createPgAdapter`, which sizes the pool for the
 * application and would let the lock's connection be recycled underneath the lock.
 */
async function openPrismaLockSession(databaseUrl: string): Promise<DbLockSession> {
  const { connectionString, schema } = pgAdapterConfig(databaseUrl);
  const pool = { connectionString, max: 1, idleTimeoutMillis: 0 };
  const adapter = schema === undefined
    ? new PrismaPg(pool)
    : new PrismaPg({ ...pool, options: `-c search_path=${schema}` }, { schema });
  const client = new PrismaClient({ adapter });
  const key = dbRunLockKey(databaseUrl).toString();

  return {
    /**
     * `pg_try_advisory_lock` rather than the blocking variant: it answers a boolean Prisma can deserialize
     * (`pg_advisory_lock` returns `void`, which Prisma refuses), and polling keeps the wait budget in this helper.
     */
    async tryLock(waitMs: number): Promise<boolean> {
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        const [row] = await client.$queryRawUnsafe<Array<{ locked: boolean }>>(
          'SELECT pg_try_advisory_lock($1::bigint) AS locked', key,
        );
        if (row?.locked === true) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
    async unlock(): Promise<void> {
      await client.$queryRawUnsafe('SELECT pg_advisory_unlock($1::bigint)', key);
    },
    close: () => client.$disconnect(),
  };
}

const defaultLog = (message: string): void => { process.stderr.write(`${message}\n`); };

/** Best-effort close: on the abort path a failing close only means the connection was already going away. */
async function closeQuietly(session: DbLockSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // Nothing to do: the process is about to fail the run.
  }
}

/**
 * Takes the run lock for one database, waiting (bounded) for a live run to finish. Contention never resolves to "go
 * ahead anyway": when the lock cannot be had, this **throws** and `globalSetup` aborts before its force-reset.
 * Unserialised execution is opt-in, through `KODA_DB_RUN_LOCK=off` in `globalSetup`.
 */
export async function acquireDbRunLock(
  databaseUrl: string,
  options: AcquireDbRunLockOptions = {},
): Promise<DbRunLock> {
  const { waitMs = DEFAULT_WAIT_MS, log = defaultLog, openSession = openPrismaLockSession } = options;

  let session: DbLockSession;
  try {
    session = await openSession(databaseUrl);
  } catch (error) {
    // Fail closed: without a session this run cannot tell whether another run is using the database, and the next step
    // force-resets it.
    throw new Error(
      `koda: could not open the test-database lock session (${String(error)}); aborting instead of resetting a test `
      + 'database this run cannot lock (set KODA_DB_RUN_LOCK=off to run unserialised on a database nobody else uses)',
    );
  }

  const startedAt = Date.now();
  let lockError: unknown;
  try {
    if (await session.tryLock(waitMs)) {
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= WAIT_NOTICE_MS) {
        // Serialisation working: say so, because a silent extra minute looks like a hang.
        log(`koda: waited ${Math.round(waitedMs / 1000)}s for another DB-mode run on this test database`);
      }
      return heldLock(session);
    }
  } catch (error) {
    lockError = error;
  }

  const waitedMs = Math.round((Date.now() - startedAt) / 1000);
  await closeQuietly(session);
  throw new Error(lockError === undefined
    ? `koda: another DB-mode run has held this test database for ${waitedMs}s and did not release it; aborting instead `
      + 'of force-resetting the database it is using (let that run finish, or set KODA_DB_RUN_LOCK=off when this '
      + 'database is not shared)'
    : `koda: the test-database lock failed (${String(lockError)}); aborting instead of resetting a test database this `
      + 'run cannot lock (set KODA_DB_RUN_LOCK=off to run unserialised on a database nobody else uses)');
}

/** The held-lock handle: one release per lock, and teardown never fails on it. */
function heldLock(session: DbLockSession): DbRunLock {
  let released: Promise<void> | undefined;
  const release = (): Promise<void> => {
    // One release per lock: a teardown that runs twice must not unlock a lock this run no longer holds.
    released ??= (async () => {
      try {
        await session.unlock();
      } catch {
        // Best effort: the connection closing releases the advisory lock anyway.
      }
      try {
        await session.close();
      } catch {
        // Daemon already gone.
      }
    })();
    return released;
  };

  return { release };
}

/**
 * Run-wide state, on `globalThis` rather than in a module variable: Vitest runs global setup once per project
 * (`db-shared` and `db-isolated`) with its own module instance, so a module-level cache would take the advisory lock
 * twice and the second acquisition would wait on the first one's own lock until its budget expired.
 */
interface RunLockSlot { readonly locks: Map<string, Promise<DbRunLock>>; current?: DbRunLock }
const SLOT = Symbol.for('koda.test.dbRunLock');

function slot(): RunLockSlot {
  const holder = globalThis as unknown as Record<symbol, RunLockSlot | undefined>;
  holder[SLOT] ??= { locks: new Map() };
  return holder[SLOT] as RunLockSlot;
}

/**
 * The entry point `globalSetup` uses: the first call for a database takes the lock, every later call in this process
 * (however many projects cause global setup to run) answers the same lock — or the same failure, since a run that could
 * not take the lock must not have a later project retry the force-reset behind its back.
 */
export function acquireProcessDbRunLock(
  databaseUrl: string,
  options: AcquireDbRunLockOptions = {},
): Promise<DbRunLock> {
  const state = slot();
  const existing = state.locks.get(databaseUrl);
  if (existing !== undefined) return existing;
  const created = acquireDbRunLock(databaseUrl, options);
  state.locks.set(databaseUrl, created);
  return created;
}

/** The lock `globalSetup` took, so `globalTeardown` can release it (in the same process, from another module instance). */
export function rememberDbRunLock(lock: DbRunLock | undefined): void {
  slot().current = lock;
}

/** Releases (and forgets) the remembered lock; a no-op when `globalSetup` took none, or when teardown runs twice. */
export async function releaseRememberedDbRunLock(): Promise<void> {
  const state = slot();
  const lock = state.current;
  state.current = undefined;
  await lock?.release();
}
