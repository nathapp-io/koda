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

  it('marks the principal as not revoked when the payload tokenVersion matches the current one', async () => {
    mockCacheManager.get.mockResolvedValue(0);

    const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 0 });

    expect(principal.revoked).toBe(false);
  });

  it('marks the principal as revoked when the current tokenVersion is ahead of the payload', async () => {
    mockCacheManager.get.mockResolvedValue(2);

    const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 1 });

    expect(principal.revoked).toBe(true);
  });

  it('resolves the current tokenVersion via the repository when not cached', async () => {
    mockCacheManager.get.mockImplementation(async (_keys: unknown, resolver: () => Promise<number>) => resolver());
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 3 });

    const principal = await provider.getPrincipal({ sub: 'user-1', email: 'a@b.com', role: 'MEMBER', tokenVersion: 1 });

    expect(mockAuthRepository.findUserById).toHaveBeenCalledWith('user-1');
    expect(principal.revoked).toBe(true);
  });
});
