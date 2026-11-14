/** Per-user revocation state, cached for 60 s by JwtAuthProvider. */
export interface UserAuthState {
  tokenVersion: number;
  disabled: boolean;
}

export function userAuthStateCacheKey(userId: string): string[] {
  return ['user-auth-state', userId];
}

/**
 * One session's activity, cached for 60 s by `JwtAuthProvider`.
 *
 * The cached value is this object and never a bare boolean: a cached "inactive" must not be
 * indistinguishable from a cache miss, or the next request would re-read the store on every call.
 * Every revoke in this feature evicts the key by its direct parts — the MEMORY cache strategy has no
 * tag registry (see the note in `AuthService.logout`), so a tag would never match — and takes
 * `withAuthSessionCacheLock` around the eviction, which is also held across the fill.
 */
export interface SessionActivity {
  active: boolean;
}

export function authSessionCacheKey(sessionId: string): string[] {
  return ['auth-session', sessionId];
}

interface AuthSessionCacheLock {
  /** Resolves when every earlier holder of this session's lock has left it. */
  tail: Promise<void>;
  /** Callers holding or waiting for the lock; the entry is dropped when this reaches zero. */
  callers: number;
}

/**
 * Process-local lock entries, one per session, removed as soon as the last caller leaves, so the map
 * cannot grow. One process is enough: the API is single-replica and the cache strategy is MEMORY.
 */
const sessionCacheLocks = new Map<string, AuthSessionCacheLock>();

/**
 * Serialises every read, fill and eviction of one session's cached activity.
 *
 * The fill in `JwtAuthProvider` reads the session store and then writes the answer, and a revoke evicts
 * the key. Without a shared fence those two interleave, and a lookup that read `active: true` *before* a
 * logout or a reuse revocation could write that answer *after* the eviction, keeping a revoked session
 * valid for the rest of the 60 s TTL. Holding this lock across the whole fill — the store read *and* the
 * write `CacheManager.get` performs — and across every eviction makes both orders safe: a fill that
 * started before the revoke commits its answer first and is evicted immediately afterwards, and a fill
 * that acquires the lock after the eviction re-reads the store and sees the revocation.
 *
 * Callers for different sessions never wait on each other.
 */
export async function withAuthSessionCacheLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const lock = sessionCacheLocks.get(sessionId) ?? { tail: Promise.resolve(), callers: 0 };
  sessionCacheLocks.set(sessionId, lock);
  lock.callers += 1;

  const previous = lock.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  lock.tail = previous.then(() => gate);

  try {
    await previous;
    return await task();
  } finally {
    release();
    lock.callers -= 1;
    if (lock.callers === 0) sessionCacheLocks.delete(sessionId);
  }
}

/** Invalidate after any write to tokenVersion, disabled or role. */
export function userTokenVersionCacheTag(userId: string): string {
  return `USER:${userId}`;
}
