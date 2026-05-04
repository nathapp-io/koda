import { DynamicModule, Global, Injectable, Module } from '@nestjs/common';

export enum CacheStrategy {
  MEMORY = 'MEMORY',
}

type CacheMode = 'key' | 'tag';

interface CacheInvalidateOptions {
  mode?: CacheMode;
}

interface CacheSetOptions {
  tags?: string[];
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  tags: string[];
}

interface CacheModuleMemoryOptions {
  lruSize?: number;
  ttl?: string | number;
}

interface CacheModuleOptions {
  isGlobal?: boolean;
  strategy: CacheStrategy;
  memory?: CacheModuleMemoryOptions;
}

@Injectable()
export class CacheManager {
  private readonly store = new Map<string, CacheEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();

  async get<T>(
    key: string | string[],
    resolver?: () => Promise<T> | T,
    ttl = 60_000,
    options?: CacheSetOptions,
  ): Promise<T> {
    const normalizedKey = this.normalizeKey(key);
    const cached = this.store.get(normalizedKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    if (!resolver) {
      return null as T;
    }

    const value = await resolver();
    this.set(normalizedKey, value, ttl, options);
    return value;
  }

  async invalidate(key: string, options?: CacheInvalidateOptions): Promise<void> {
    const mode = options?.mode ?? 'key';
    if (mode === 'tag') {
      this.invalidateTag(key);
      return;
    }

    this.deleteKey(key);
  }

  private set(key: string, value: unknown, ttl: number, options?: CacheSetOptions): void {
    const expiresAt = Date.now() + ttl;
    const tags = options?.tags ?? [];
    this.store.set(key, { value, expiresAt, tags });

    for (const tag of tags) {
      const keys = this.tagIndex.get(tag) ?? new Set<string>();
      keys.add(key);
      this.tagIndex.set(tag, keys);
    }
  }

  private deleteKey(key: string): void {
    const existing = this.store.get(key);
    if (!existing) {
      return;
    }

    for (const tag of existing.tags) {
      const keys = this.tagIndex.get(tag);
      keys?.delete(key);
      if (keys && keys.size === 0) {
        this.tagIndex.delete(tag);
      }
    }

    this.store.delete(key);
  }

  private invalidateTag(tag: string): void {
    const keys = this.tagIndex.get(tag);
    if (!keys) {
      return;
    }

    for (const key of keys) {
      this.deleteKey(key);
    }
    this.tagIndex.delete(tag);
  }

  private normalizeKey(key: string | string[]): string {
    if (Array.isArray(key)) {
      return key.map((part) => String(part).toUpperCase()).join(':');
    }
    return key;
  }
}

@Global()
@Module({})
export class CacheModule {
  static register(options: CacheModuleOptions): DynamicModule {
    if (options.strategy !== CacheStrategy.MEMORY) {
      throw new Error('Only MEMORY cache strategy is supported in this environment.');
    }

    return {
      module: CacheModule,
      global: options.isGlobal ?? true,
      providers: [CacheManager],
      exports: [CacheManager],
    };
  }
}