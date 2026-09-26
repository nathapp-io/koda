/** Per-user revocation state, cached for 60 s by JwtAuthProvider. */
export interface UserAuthState {
  tokenVersion: number;
  disabled: boolean;
}

export function userAuthStateCacheKey(userId: string): string[] {
  return ['user-auth-state', userId];
}

/** Invalidate after any write to tokenVersion, disabled or role. */
export function userTokenVersionCacheTag(userId: string): string {
  return `USER:${userId}`;
}
