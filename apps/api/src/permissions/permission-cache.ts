import { Injectable } from '@nestjs/common';
import { CacheManager } from '@nathapp/nestjs-cache';

/** The cache tag every effective-permission entry carries. */
export const PERMISSIONS_CACHE_TAG = 'permissions';

/** How long an effective-permission entry lives when no write invalidates it first. */
export const PERMISSIONS_CACHE_TTL_MS = 60_000;

/**
 * Permissions P1a: the effective-permission cache shared by `PermissionService` (reads) and
 * `MembershipService` (writes).
 *
 * The API runs the MEMORY cache strategy, which keeps no tag registry: tag-mode invalidation there
 * deletes only a literal key named after the tag and leaves every entry in place. So the tag is
 * invalidated for strategies that support it, and the entries are also versioned by a generation
 * counter that every invalidation bumps. The next read after a write builds a new key and recomputes;
 * stale entries are never read again and age out through the TTL and the LRU bound. The counter is
 * per process, which is correct for a single API instance (cross-instance invalidation is out of scope).
 */
@Injectable()
export class PermissionCache {
  private generation = 0;

  constructor(private readonly cache: CacheManager) {}

  async remember<T>(parts: readonly string[], load: () => Promise<T>): Promise<T> {
    const key = [PERMISSIONS_CACHE_TAG, String(this.generation), ...parts];
    const value = await this.cache.get<T>(key, load, PERMISSIONS_CACHE_TTL_MS, {
      tags: [PERMISSIONS_CACHE_TAG],
    });
    // The loader's value is never null or undefined (arrays), so a null here means the cache failed
    // open and fell through without calling the loader; compute directly rather than invent a value.
    return value ?? load();
  }

  /** Call after the write committed, inside the same service call. */
  async invalidate(): Promise<void> {
    this.generation += 1;
    await this.cache.invalidate(PERMISSIONS_CACHE_TAG, { mode: 'tag' });
  }
}
