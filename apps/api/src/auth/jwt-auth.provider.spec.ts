import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { JwtAuthProvider } from './jwt-auth.provider';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { AuthSessionService } from './sessions/auth-session.service';

describe('JwtAuthProvider', () => {
  let provider: JwtAuthProvider;

  const mockAuthRepository = {
    findUserById: vi.fn(),
  };

  const mockCacheManager = {
    get: vi.fn(),
  };

  const mockAuthSessions = {
    isActive: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthProvider,
        { provide: PrismaAuthRepository, useValue: mockAuthRepository },
        { provide: CacheManager, useValue: mockCacheManager },
        { provide: AuthSessionService, useValue: mockAuthSessions },
      ],
    }).compile();

    provider = module.get<JwtAuthProvider>(JwtAuthProvider);
    mockAuthSessions.isActive.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const payload = (tokenVersion: number) => ({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion });

  it('is not revoked when the state matches the token', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    expect((await provider.getPrincipal(payload(0))).revoked).toBe(false);
  });

  it('is revoked when the current tokenVersion is ahead of the token', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 2, disabled: false });
    expect((await provider.getPrincipal(payload(1))).revoked).toBe(true);
  });

  it('is revoked when the user is disabled, even with a current tokenVersion', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: true });
    expect((await provider.getPrincipal(payload(0))).revoked).toBe(true);
  });

  it('loads the state from the repository on a cache miss', async () => {
    mockCacheManager.get.mockImplementation(async (_keys: unknown, resolver: () => Promise<unknown>) => resolver());
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 1, disabled: false });

    const principal = await provider.getPrincipal(payload(1));

    expect(mockAuthRepository.findUserById).toHaveBeenCalledWith('user-1');
    expect(principal.revoked).toBe(false);
    expect(mockCacheManager.get).toHaveBeenCalledWith(
      ['user-auth-state', 'user-1'], expect.any(Function), 60_000, { tags: ['USER:user-1'] },
    );
  });

  it('treats a user that no longer exists as revoked', async () => {
    mockCacheManager.get.mockImplementation(async (_keys: unknown, resolver: () => Promise<unknown>) => resolver());
    mockAuthRepository.findUserById.mockResolvedValue(null);
    expect((await provider.getPrincipal(payload(0))).revoked).toBe(true);
  });

  // Permissions P1 US-005: UserPrincipal has no `projectRole` field any more. The JWT claim of that
  // name is still ignored (a forged claim must not reach a principal), and the provider must not even
  // set an own `projectRole: undefined` property.
  it('AC-3: a projectRole claim changes nothing the principal carries', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    const base = { sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0 };
    const plain = await provider.getPrincipal(base);
    const forged = await provider.getPrincipal({ ...base, projectRole: 'ADMIN' });
    expect(forged).toEqual(plain);
  });

  it('SECURITY: the principal carries no own projectRole property, whatever the claim says', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    for (const claim of ['ADMIN', 'DEVELOPER', 'VIEWER', 'owner', '', null, 42]) {
      const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, projectRole: claim });
      expect(Object.prototype.hasOwnProperty.call(principal, 'projectRole')).toBe(false);
    }
  });

  // The claims that DO survive, unchanged by the projectRole removal.
  it('keeps role, email, authorities and extra from the payload', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'ADMIN', tokenVersion: 0 });
    expect(principal).toMatchObject({
      actorType: 'user',
      id: 'user-1',
      name: 'a@b.com',
      email: 'a@b.com',
      role: 'ADMIN',
      authorities: ['ADMIN'],
      extra: { sub: 'user-1', email: 'a@b.com', role: 'ADMIN' },
      blacklisted: false,
    });
  });

  describe('auth-sessions US-003 — session activity on access tokens', () => {
    /** A cache that really caches: one value per key, a resolver runs once, `false` is retained. */
    const cachingCacheManager = (): Map<string, unknown> => {
      const store = new Map<string, unknown>();
      mockCacheManager.get.mockImplementation(async (keys: unknown, resolver: () => Promise<unknown>) => {
        const key = Array.isArray(keys) ? keys.join('|') : String(keys);
        if (!store.has(key)) store.set(key, await resolver());
        return store.get(key);
      });
      return store;
    };

    it("AC-1: a payload carrying sid 's1' yields a principal carrying sessionId 's1'", async () => {
      cachingCacheManager();
      const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, sid: 's1' });
      expect(principal.sessionId).toBe('s1');
    });

    it("AC-2: an inactive session revokes the principal, and isActive is asked about 's1' at a Date", async () => {
      cachingCacheManager();
      mockAuthSessions.isActive.mockResolvedValue(false);

      const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, sid: 's1' });

      expect(principal.revoked).toBe(true);
      expect(mockAuthSessions.isActive).toHaveBeenCalledOnce();
      const [sessionId, now] = mockAuthSessions.isActive.mock.calls[0] as [string, unknown];
      expect(sessionId).toBe('s1');
      expect(now).toBeInstanceOf(Date);
    });

    it('AC-3: a payload with no sid never asks the session store', async () => {
      cachingCacheManager();
      await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0 });
      expect(mockAuthSessions.isActive).not.toHaveBeenCalled();
    });

    it('AC-4: two calls for one sid inside 60 s ask once and both stay revoked', async () => {
      const store = cachingCacheManager();
      mockAuthSessions.isActive.mockResolvedValue(false);
      const payload = { sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, sid: 's1' };

      const first = await provider.getPrincipal(payload);
      const second = await provider.getPrincipal(payload);

      expect(mockAuthSessions.isActive).toHaveBeenCalledOnce();
      expect(first.revoked).toBe(true);
      expect(second.revoked).toBe(true);
      // The cached answer is the object, keyed by the session: a cached `false` is never a miss.
      expect(store.get('auth-session|s1')).toEqual({ active: false });
    });
  });
});
