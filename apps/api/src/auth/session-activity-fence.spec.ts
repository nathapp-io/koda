import { Test, TestingModule } from '@nestjs/testing';
import { JwtRefreshStrategyProvider, JwtStrategyProvider } from '@nathapp/nestjs-auth';
import { CacheManager } from '@nathapp/nestjs-cache';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AuthException } from '@nathapp/nestjs-common';
import { AUTH_CFG } from '../config/auth.config';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { MembershipService } from '../permissions/membership.service';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { AuthService } from './auth.service';
import { AuthSessionService } from './sessions/auth-session.service';
import { JwtAuthProvider } from './jwt-auth.provider';

/**
 * auth-sessions (branch fix B1) — the fence between a session-activity cache fill and a revoke.
 *
 * Both regressions pause the store read (`AuthSessionService.isActive`) *before* the cache write, let a
 * logout / reuse revocation commit and evict the key while the lookup is still in flight, and then
 * release the lookup. Without a shared per-session lock the paused lookup writes its pre-revocation
 * `{ active: true }` into the cache *after* the eviction, so the revoked access token keeps answering
 * for the rest of the 60 s TTL. The assertions therefore read the cache entry directly and then ask the
 * provider again: a fenced fill leaves the key empty and the next lookup re-reads the store.
 */

/** The MEMORY strategy's observable behaviour: one value per key, one load, evicted by direct key. */
class MemoryCache {
  readonly store = new Map<string, unknown>();
  readonly loads: string[] = [];

  async get(keys: string[], resolver?: () => Promise<unknown>): Promise<unknown> {
    const key = keys.join('|');
    if (this.store.has(key)) return this.store.get(key);
    if (resolver === undefined) return null;
    this.loads.push(key);
    const value = await resolver();
    // The write happens after the resolver settles — the window the fence has to close.
    this.store.set(key, value);
    return value;
  }

  async invalidate(keys: string[]): Promise<void> {
    this.store.delete(keys.join('|'));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('session activity cache fence', () => {
  let moduleRef: TestingModule;
  let provider: JwtAuthProvider;
  let service: AuthService;
  let cache: MemoryCache;

  const mockAuthRepository = {
    findUserById: vi.fn(),
    bumpTokenVersion: vi.fn(),
  };

  const mockAuthSessions = {
    isActive: vi.fn(),
    revoke: vi.fn(),
    rotate: vi.fn(),
    start: vi.fn(),
  };

  const mockAuditRecorder = {
    record: vi.fn(),
    audited: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  };

  const mockMembership = { isGlobalAdmin: vi.fn() };

  const mockAuthConfig = { registrationEnabled: false, ownerEmail: undefined as string | undefined };

  const accessPayload = (sid: string) => ({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, sid });

  beforeAll(async () => {
    cache = new MemoryCache();
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0, disabled: false });
    mockMembership.isGlobalAdmin.mockResolvedValue(false);

    moduleRef = await Test.createTestingModule({
      providers: [
        JwtAuthProvider,
        AuthService,
        { provide: PrismaAuthRepository, useValue: mockAuthRepository },
        { provide: CacheManager, useValue: cache },
        { provide: AuthSessionService, useValue: mockAuthSessions },
        { provide: AuditRecorder, useValue: mockAuditRecorder },
        { provide: MembershipService, useValue: mockMembership },
        { provide: AUTH_CFG, useValue: mockAuthConfig },
        { provide: TRANSACTION_MANAGER, useValue: { run: vi.fn((fn: () => Promise<unknown>) => fn()) } },
        {
          provide: JwtStrategyProvider,
          useValue: { sign: vi.fn(() => 'access-token') },
        },
        {
          provide: JwtRefreshStrategyProvider,
          useValue: {
            sign: vi.fn(() => `e30.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.signature`),
          },
        },
      ],
    }).compile();

    provider = moduleRef.get(JwtAuthProvider);
    service = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    cache.store.clear();
    cache.loads.length = 0;
    mockAuthSessions.isActive.mockReset();
    mockAuthSessions.revoke.mockReset().mockResolvedValue(true);
    mockAuthSessions.rotate.mockReset();
    mockAuditRecorder.record.mockReset().mockResolvedValue(undefined);
  });

  /** A store read that answers `true` and then holds the fill open until the returned gate resolves. */
  const pausedLookup = () => {
    const entered = deferred();
    const gate = deferred();
    mockAuthSessions.isActive.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return true;
    });
    return { entered, gate };
  };

  it('AC-8: a lookup paused across a logout cannot re-cache the live answer', async () => {
    const { entered, gate } = pausedLookup();
    const revoked = deferred();
    mockAuthSessions.revoke.mockImplementation(async () => {
      revoked.resolve();
      return true;
    });

    const fill = provider.getPrincipal(accessPayload('s-logout'));
    await entered.promise;

    // The revoke commits and its eviction waits for the paused fill (fence) — released below.
    const logout = service.logout('user-1', 's-logout');
    await revoked.promise;
    gate.resolve();
    await Promise.all([fill, logout]);

    expect(cache.store.has('auth-session|s-logout')).toBe(false);

    mockAuthSessions.isActive.mockResolvedValue(false);
    const after = await provider.getPrincipal(accessPayload('s-logout'));

    expect(after.revoked).toBe(true);
    expect(mockAuthSessions.isActive).toHaveBeenCalledTimes(2);
  });

  it('AC-7: a lookup paused across a reuse revocation cannot re-cache the live answer', async () => {
    const { entered, gate } = pausedLookup();
    const revoked = deferred();
    mockAuthSessions.rotate.mockImplementation(async () => {
      revoked.resolve();
      return { kind: 'reused', userId: 'user-1' };
    });

    const fill = provider.getPrincipal(accessPayload('s-reuse'));
    await entered.promise;

    const refresh = service.refresh({
      id: 'user-1',
      revoked: false,
      extra: { sessionId: 's-reuse', tokenId: 't-presented' },
    } as never).catch((error: unknown) => error);
    await revoked.promise;
    gate.resolve();
    await Promise.all([fill, refresh]);

    expect(cache.store.has('auth-session|s-reuse')).toBe(false);

    mockAuthSessions.isActive.mockResolvedValue(false);
    const after = await provider.getPrincipal(accessPayload('s-reuse'));

    expect(after.revoked).toBe(true);
    expect(mockAuthSessions.isActive).toHaveBeenCalledTimes(2);
    await expect(
      service.refresh({
        id: 'user-1',
        revoked: false,
        extra: { sessionId: 's-reuse', tokenId: 't-presented' },
      } as never),
    ).rejects.toBeInstanceOf(AuthException);
  });
});
