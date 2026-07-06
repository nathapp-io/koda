export function userTokenVersionCacheKey(userId: string): string[] {
  return ['user-token-version', userId];
}

export function userTokenVersionCacheTag(userId: string): string {
  return `USER:${userId}`;
}
