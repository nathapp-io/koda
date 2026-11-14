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
 * tag registry (see the note in `AuthService.logout`), so a tag would never match.
 */
export interface SessionActivity {
  active: boolean;
}

export function authSessionCacheKey(sessionId: string): string[] {
  return ['auth-session', sessionId];
}

/** Invalidate after any write to tokenVersion, disabled or role. */
export function userTokenVersionCacheTag(userId: string): string {
  return `USER:${userId}`;
}
