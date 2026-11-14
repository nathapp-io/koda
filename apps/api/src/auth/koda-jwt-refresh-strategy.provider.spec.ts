import { Test, TestingModule } from '@nestjs/testing';
import { JWT_OPTIONS } from '@nathapp/nestjs-auth';
import { KodaJwtRefreshStrategyProvider } from './koda-jwt-refresh-strategy.provider';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('KodaJwtRefreshStrategyProvider', () => {
  let provider: KodaJwtRefreshStrategyProvider;

  const mockAuthRepository = {
    findUserById: vi.fn(),
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
    vi.clearAllMocks();
  });

  it('is not revoked when the payload tokenVersion matches the user record', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0 });

    const principal = await provider.validate({ headers: {} }, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(false);
  });

  it('is revoked when the user tokenVersion has advanced past the payload', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 2 });

    const principal = await provider.validate({ headers: {} }, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(true);
  });

  it('is revoked when the user no longer exists', async () => {
    mockAuthRepository.findUserById.mockResolvedValue(null);

    const principal = await provider.validate({ headers: {} }, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.revoked).toBe(true);
  });

  it('AC-8: propagates session and refresh token claims into extra', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0, disabled: false });

    const principal = await provider.validate({ headers: {} }, {
      sub: 'user-1', tokenVersion: 0, sid: 's1', jti: 't1',
    } as never);

    expect(principal.extra).toEqual({ sessionId: 's1', tokenId: 't1' });
  });

  it('AC-9: legacy claims yield no session or token ids in extra', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0, disabled: false });

    const principal = await provider.validate({ headers: {} }, { sub: 'user-1', tokenVersion: 0 });

    expect(principal.extra).toEqual({});
    expect(principal.extra).not.toHaveProperty('sessionId');
    expect(principal.extra).not.toHaveProperty('tokenId');
  });

  it('AC-11: disabled users remain revoked even with current tokenVersion and session claims', async () => {
    mockAuthRepository.findUserById.mockResolvedValue({ tokenVersion: 0, disabled: true });

    const principal = await provider.validate({ headers: {} }, {
      sub: 'user-1', tokenVersion: 0, sid: 's1', jti: 't1',
    } as never);

    expect(principal.revoked).toBe(true);
    expect(principal.extra).toEqual({ sessionId: 's1', tokenId: 't1' });
  });
});
