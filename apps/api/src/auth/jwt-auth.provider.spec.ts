import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { JwtAuthProvider } from './jwt-auth.provider';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('JwtAuthProvider', () => {
  let provider: JwtAuthProvider;

  const mockAuthRepository = {
    findUserById: vi.fn(),
  };

  const mockCacheManager = {
    get: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthProvider,
        { provide: PrismaAuthRepository, useValue: mockAuthRepository },
        { provide: CacheManager, useValue: mockCacheManager },
      ],
    }).compile();

    provider = module.get<JwtAuthProvider>(JwtAuthProvider);
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
});
