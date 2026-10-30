/**
 * One DB-mode run at a time per test database (fix round 1, F1).
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
 * - a second run blocks inside `pg_advisory_lock` until the first finishes, with `lock_timeout` as its budget: once the
 *   budget expires it warns and runs anyway, because failing a gate on a lock timeout is worse than the collision;
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

/** One held-or-not lock session: the unit cases inject a double instead of opening a connection. */
export interface DbLockSession {
  /** Blocks until the lock is granted; answers false when the wait budget ran out. */
  tryLock(waitMs: number): Promise<boolean>;
  unlock(): Promise<void>;
  close(): Promise<void>;
}

export interface DbRunLock {
  /** False when this run went ahead without the lock (budget expired, or the database was unreachable). */
  readonly ownsLock: boolean;
  release(): Promise<void>;
}

export interface AcquireDbRunLockOptions {
  /** Total time to wait for another run before going ahead. */
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

/**
 * Takes the run lock for one database, waiting (bounded) for a live run to finish. Contention never throws: a run that
 * cannot get the lock in time goes ahead and says so.
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
    log(`koda: could not open the test-database lock session (${String(error)}); the run goes ahead unserialised`);
    return { ownsLock: false, release: async () => undefined };
  }

  let ownsLock = false;
  const startedAt = Date.now();
  try {
    ownsLock = await session.tryLock(waitMs);
  } catch (error) {
    log(`koda: the test-database lock failed (${String(error)}); the run goes ahead unserialised`);
  }
  const waitedMs = Date.now() - startedAt;
  if (ownsLock && waitedMs >= WAIT_NOTICE_MS) {
    // Serialisation working: say so, because a silent extra minute looks like a hang.
    log(`koda: waited ${Math.round(waitedMs / 1000)}s for another DB-mode run on this test database`);
  }
  if (!ownsLock) {
    log(`koda: another DB-mode run has been holding this test database for ${Math.round(waitMs / 1000)}s; going ahead without the lock`);
  }

  let released: Promise<void> | undefined;
  const release = (): Promise<void> => {
    // One release per lock: a teardown that runs twice must not unlock a lock this run no longer holds.
    released ??= (async () => {
      try {
        if (ownsLock) await session.unlock();
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

  return { ownsLock, release };
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
 * (however many projects cause global setup to run) answers the same lock.
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
