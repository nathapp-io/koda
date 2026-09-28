import { Test, TestingModule } from '@nestjs/testing';
import { CacheManager } from '@nathapp/nestjs-cache';
import { JwtAuthProvider } from './jwt-auth.provider';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('JwtAuthProvider', () => {
  let provider: JwtAuthProvider;

  const mockAuthRepository = {
    findUserById: jest.fn(),
  };

  const mockCacheManager = {
    get: jest.fn(),
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
    jest.clearAllMocks();
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

  // SECURITY (#144): the CASL ability factory reads UserPrincipal.projectRole
  // when deciding permission for routes that don't go through
  // ProjectMembershipGuard (e.g. PATCH/DELETE /api/comments/:id via the
  // global permission guard). A forged JWT carrying `projectRole: 'ADMIN'`
  // would otherwise grant unconditional DELETE Comment. This test pins the
  // invariant that the JWT auth provider NEVER carries projectRole onto the
  // principal — only ProjectMembershipGuard sets it, and only from the DB.
  it('SECURITY: never carries projectRole from the JWT onto the principal', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    const forged = { sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, projectRole: 'ADMIN' };
    const principal = await provider.getPrincipal(forged);
    expect(principal.projectRole).toBeUndefined();
  });

  it('SECURITY: an empty/garbage projectRole claim still does not leak onto the principal', async () => {
    mockCacheManager.get.mockResolvedValue({ tokenVersion: 0, disabled: false });
    for (const claim of ['DEVELOPER', 'VIEWER', 'owner', '', null, 42]) {
      const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0, projectRole: claim });
      expect(principal.projectRole).toBeUndefined();
    }
  });
});
