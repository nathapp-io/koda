import { Test, TestingModule } from '@nestjs/testing';
import { JWT_OPTIONS } from '@nathapp/nestjs-auth';
import { KodaJwtRefreshStrategyProvider } from './koda-jwt-refresh-strategy.provider';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('KodaJwtRefreshStrategyProvider', () => {
  let provider: KodaJwtRefreshStrategyProvider;

  const mockAuthRepository = {
    findUserById: jest.fn(),
  };

  const mockJwtOptions = {
    jwtOptions: { secret: 'access-secret' },
    refreshJwtOptions: { secret: 'refresh-secret' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KodaJwtRefreshStrategyProvider,
        { provide: PrismaAuthRepository, useValue: mockAuthRepository },
        { provide: JWT_OPTIONS, useValue: mockJwtOptions },
      ],
    }).compile();

    provider = module.get<KodaJwtRefreshStrategyProvider>(KodaJwtRefreshStrategyProvider);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('is not revoked when the payload tokenVersion matches the user record', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0 });

    const principal = await provider.validate(undefined, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(false);
  });

  it('is revoked when the user tokenVersion has advanced past the payload', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 2 });

    const principal = await provider.validate(undefined, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(true);
  });

  it('is revoked when the user no longer exists', async () => {
    mockAuthRepository.findUserById.mockResolvedValue(null);

    const principal = await provider.validate(undefined, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(true);
  });
});
