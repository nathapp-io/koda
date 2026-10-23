import type { Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtStrategyProvider, JwtRefreshStrategyProvider } from '@nathapp/nestjs-auth';
import { CacheManager } from '@nathapp/nestjs-cache';
import { AuthService } from './auth.service';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { ConfigService } from '@nestjs/config';
import { AppException, AuthException, ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../generated/prisma/client';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AUTH_CFG } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import type { IPrincipal } from './types';
// Default (not `import * as`): the interop namespace object has
// non-configurable properties, which would make vi.spyOn(bcrypt, 'hash') throw.
import bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let authRepo: PrismaAuthRepository;
  let moduleRef: TestingModule;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    passwordHash: 'hashed-password',
    tokenVersion: 0,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAuthRepository = {
    findAnyUser: vi.fn(),
    createUser: vi.fn(),
    findAnyUserAndCreate: vi.fn(),
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    bumpTokenVersion: vi.fn(),
  };

  const mockConfigService = {
    get: vi.fn(),
  };

  const mockAuthConfig = {
    registrationEnabled: false,
    ownerEmail: undefined as string | undefined,
  };

  const mockMembership = {
    isGlobalAdmin: vi.fn(),
    bindOwnerIfFirst: vi.fn(),
    bindBaseline: vi.fn(),
    // B3/B4: the registration transaction is handed to MembershipService, which flushes its deferred
    // cache invalidations when the callback resolves.
    afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
  };

  const mockTxManager = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
  };

  const mockJwtStrategyProvider = {
    sign: vi.fn(),
  };

  const mockJwtRefreshStrategyProvider = {
    sign: vi.fn(),
  };

  const mockCacheManager = {
    invalidate: vi.fn(),
  };

  beforeEach(async () => {
    // Drop queued once-values and per-test implementations so test order cannot matter.
    Object.values(mockAuthRepository).forEach((m) => m.mockReset());
    mockConfigService.get.mockReset();
    mockJwtStrategyProvider.sign.mockReset();
    mockJwtRefreshStrategyProvider.sign.mockReset();
    mockCacheManager.invalidate.mockReset();
    Object.values(mockMembership).forEach((m) => m.mockReset());

    const module: TestingModule = moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaAuthRepository, useValue: mockAuthRepository },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AUTH_CFG, useValue: mockAuthConfig },
        { provide: MembershipService, useValue: mockMembership },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
        { provide: JwtStrategyProvider, useValue: mockJwtStrategyProvider },
        { provide: JwtRefreshStrategyProvider, useValue: mockJwtRefreshStrategyProvider },
        { provide: CacheManager, useValue: mockCacheManager },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    authRepo = module.get<PrismaAuthRepository>(PrismaAuthRepository);

    // Default mock values
    mockJwtStrategyProvider.sign.mockReturnValue('mock-token');
    mockJwtRefreshStrategyProvider.sign.mockReturnValue('mock-token');
    mockMembership.isGlobalAdmin.mockResolvedValue(false);
    mockAuthRepository.findUserById.mockResolvedValue(mockUser);
    mockAuthRepository.findAnyUser.mockResolvedValue(null);
    mockAuthRepository.findAnyUserAndCreate.mockImplementation(async (data) => ({ user: { ...mockUser, ...data }, firstUser: true }));
    mockMembership.bindOwnerIfFirst.mockResolvedValue(undefined);
    mockMembership.bindBaseline.mockResolvedValue(undefined);
    mockAuthConfig.registrationEnabled = false;
    mockAuthConfig.ownerEmail = undefined;
  });

  afterEach(async () => {
    await moduleRef.close();
    vi.clearAllMocks();
  });

  describe('binding-derived sessions', () => {
    it.each([[true, 'ADMIN'], [false, 'MEMBER']] as const)('AC-9/10: global admin %s yields %s', async (admin, role) => {
      mockMembership.isGlobalAdmin.mockResolvedValue(admin);
      expect(await service.roleClaim('u1')).toBe(role);
      expect(mockMembership.isGlobalAdmin).toHaveBeenCalledWith('u1');
    });

    it('AC-11/12: lookup failure propagates before either token is signed', async () => {
      const error = new Error('binding lookup unavailable');
      mockMembership.isGlobalAdmin.mockRejectedValueOnce(error);
      mockAuthRepository.findUserByEmail.mockResolvedValue({ ...mockUser, passwordHash: await bcrypt.hash('Password123!', 4) });
      await expect(service.login({ email: mockUser.email, password: 'Password123!' })).rejects.toBe(error);
      expect(mockJwtStrategyProvider.sign).not.toHaveBeenCalled();
      expect(mockJwtRefreshStrategyProvider.sign).not.toHaveBeenCalled();
    });

    it.each([true, false])('uses one role lookup for the response and claim (admin=%s)', async (admin) => {
      mockMembership.isGlobalAdmin.mockResolvedValueOnce(admin).mockResolvedValue(!admin);
      const response = await service.issueSession(mockUser);
      const role = admin ? 'ADMIN' : 'MEMBER';
      expect(response.user.role).toBe(role);
      expect(mockJwtStrategyProvider.sign).toHaveBeenCalledWith(expect.objectContaining({ role }));
      expect(mockMembership.isGlobalAdmin).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('userResponse exposes only public fields (admin=%s)', async (admin) => {
      mockMembership.isGlobalAdmin.mockResolvedValue(admin);
      const response = await service.userResponse(mockUser);
      expect(response).toEqual({
        id: mockUser.id, email: mockUser.email, name: mockUser.name,
        role: admin ? 'ADMIN' : 'MEMBER', disabled: mockUser.disabled,
        createdAt: mockUser.createdAt, updatedAt: mockUser.updatedAt,
      });
      expect(response).not.toHaveProperty('passwordHash');
      expect(response).not.toHaveProperty('tokenVersion');
      expect(JSON.stringify(response)).not.toContain(mockUser.passwordHash);
    });

    it('re-reads the committed registration tokenVersion', async () => {
      let committed = false;
      mockMembership.afterCommit.mockImplementationOnce(async fn => { const user = await fn(); committed = true; return user; });
      mockAuthRepository.findUserById.mockImplementationOnce(async id => {
        expect(committed).toBe(true);
        expect(id).toBe(mockUser.id);
        return { ...mockUser, tokenVersion: 7 };
      });
      await service.register({ email: mockUser.email, password: 'Password123!' });
      expect(mockAuthRepository.findUserById).toHaveBeenCalledWith(mockUser.id);
      expect(mockJwtStrategyProvider.sign).toHaveBeenCalledWith(expect.objectContaining({ tokenVersion: 7 }));
    });
  });

  describe('register', () => {
    it('should create a new user with bcrypt hashed password', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'Password123!',
      };

      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: mockUser,
        firstUser: true,
      });

      const result = await service.register(registerDto);

      expect(authRepo.findAnyUserAndCreate).toHaveBeenCalled();
      const createCall = (authRepo.findAnyUserAndCreate as Mock).mock.calls[0][0];
      expect(createCall.email).toBe(registerDto.email);
      expect(createCall.name).toBe(registerDto.name);

      // Verify bcrypt was used (passwordHash should not be plaintext)
      const hashedPassword = createCall.passwordHash;
      expect(hashedPassword).not.toBe(registerDto.password);
      expect(await bcrypt.compare(registerDto.password, hashedPassword)).toBe(true);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
    });

    it('should return tokens and user data', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'Password123!',
      };

      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: mockUser,
        firstUser: false,
      });

      const result = await service.register(registerDto);

      // Should not return passwordHash
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user.email).toBe(mockUser.email);
      expect(result.user.name).toBe(mockUser.name);
      expect(result.accessToken).toBe('mock-token');
      expect(result.refreshToken).toBe('mock-token');
    });

    it('trusts the repository to handle the existence-check + create atomically', async () => {
      const registerDto = {
        email: 'race@example.com',
        name: 'Race User',
        password: 'Password123!',
      };

      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser },
        firstUser: true,
      });

      await service.register(registerDto);

      // The service must NOT do its own write path (find-any + create) outside
      // one transaction — that is exactly the race the repository method
      // serializes. Its findAnyUser call is the sanctioned fast-path gate
      // (refuse before bcrypt when registration is closed), not a write path.
      expect(authRepo.createUser).not.toHaveBeenCalled();
      expect(authRepo.findAnyUserAndCreate).toHaveBeenCalledTimes(1);
    });

    it('binds the first user as Owner and every new user to the baseline', async () => {
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser, id: 'first-user' },
        firstUser: true,
      });

      await service.register({ email: 'first@example.com', name: 'First', password: 'Password123!' });

      expect(mockMembership.bindOwnerIfFirst).toHaveBeenCalledWith('first-user', true);
      expect(mockMembership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'first-user' });
    });

    it('does not bind Owner for a user that is not the first', async () => {
      mockAuthConfig.registrationEnabled = true;
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser, id: 'second-user' },
        firstUser: false,
      });

      await service.register({ email: 'second@example.com', name: 'Second', password: 'Password123!' });

      expect(mockMembership.bindOwnerIfFirst).toHaveBeenCalledWith('second-user', false);
      expect(mockMembership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'second-user' });
    });

    it('B4: a failed Owner binding rejects and issues no session', async () => {
      mockAuthConfig.registrationEnabled = true;
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser, id: 'first-user' },
        firstUser: true,
      });
      mockMembership.bindOwnerIfFirst.mockRejectedValueOnce(
        new NotFoundAppException({}, 'permissions.roleNotFound'),
      );

      await expect(
        service.register({ email: 'first@example.com', name: 'First', password: 'Password123!' }),
      ).rejects.toBeInstanceOf(NotFoundAppException);

      // The user row and its bindings are one transaction, so the failed binding takes the row with it
      // and the Owner seat stays free. The response is the failure, never a session.
      expect(mockMembership.bindBaseline).not.toHaveBeenCalled();
      expect(mockJwtStrategyProvider.sign).not.toHaveBeenCalled();
    });
  });

  describe('owner bootstrap (KODA_OWNER_EMAIL)', () => {
    const dto = { email: 'other@koda.test', name: 'Other', password: 'Password123!' };

    it('refuses the first registration when the email is not the configured owner', async () => {
      mockAuthConfig.ownerEmail = 'owner@koda.test';
      mockAuthRepository.findAnyUser.mockResolvedValue(null);
      const hashSpy = vi.spyOn(bcrypt, 'hash');

      await expect(service.register(dto)).rejects.toBeInstanceOf(ForbiddenAppException);

      // Refused before creating anything, and before paying for bcrypt.
      expect(mockAuthRepository.findAnyUserAndCreate).not.toHaveBeenCalled();
      expect(hashSpy).not.toHaveBeenCalled();
      expect(mockMembership.bindBaseline).not.toHaveBeenCalled();
      hashSpy.mockRestore();
    });

    it('accepts the first registration when the canonical email is the configured owner', async () => {
      mockAuthConfig.ownerEmail = 'owner@koda.test';
      mockAuthRepository.findAnyUser.mockResolvedValue(null);
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser, id: 'owner-user', email: 'owner@koda.test' },
        firstUser: true,
      });

      // The whitespace and casing are the DTO's, not the owner email's: both sides are canonicalised.
      await service.register({ ...dto, email: ' Owner@Koda.test ' });

      expect(mockAuthRepository.findAnyUserAndCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'owner@koda.test' }),
        { allowWhenUsersExist: false },
      );
      expect(mockMembership.bindOwnerIfFirst).toHaveBeenCalledWith('owner-user', true);
    });

    it('applies the owner rule only while the users table is empty', async () => {
      mockAuthConfig.ownerEmail = 'owner@koda.test';
      mockAuthConfig.registrationEnabled = true;
      // One user already exists, so the Owner seat is taken and the gate is open.
      mockAuthRepository.findAnyUser.mockResolvedValue({ id: 'owner-user' });
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser, id: 'late-user' },
        firstUser: false,
      });

      await service.register(dto);

      expect(mockAuthRepository.findAnyUserAndCreate).toHaveBeenCalled();
      expect(mockMembership.bindBaseline).toHaveBeenCalledWith({ type: 'USER', id: 'late-user' });
    });

    it('lets any email take the first registration when no owner email is configured', async () => {
      mockAuthConfig.ownerEmail = undefined;
      mockAuthRepository.findAnyUser.mockResolvedValue(null);
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({
        user: { ...mockUser, id: 'first-user' },
        firstUser: true,
      });

      await service.register(dto);

      expect(mockAuthRepository.findAnyUserAndCreate).toHaveBeenCalled();
      expect(mockMembership.bindOwnerIfFirst).toHaveBeenCalledWith('first-user', true);
    });
  });

  describe('registration gate', () => {
    const dto = { email: 'late@example.com', name: 'Late', password: 'Password123!' };

    it('refuses before hashing when registration is closed and users exist', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce({ id: 'existing' });
      const hashSpy = vi.spyOn(bcrypt, 'hash');

      await expect(service.register(dto)).rejects.toBeInstanceOf(ForbiddenAppException);
      expect(mockAuthRepository.findAnyUserAndCreate).not.toHaveBeenCalled();
      expect(hashSpy).not.toHaveBeenCalled();
      hashSpy.mockRestore();
    });

    it('refuses when a concurrent registration won the bootstrap race', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce(null);
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce(null);

      await expect(service.register(dto)).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('passes the flag to the repository', async () => {
      mockAuthConfig.registrationEnabled = true;
      // No findAnyUser stub: the flag is on, so the fast-path gate (and its
      // findAnyUser call) is skipped entirely — that is part of the contract.
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({ user: mockUser, firstUser: false });

      await service.register(dto);

      expect(mockAuthRepository.findAnyUserAndCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email }),
        { allowWhenUsersExist: true },
      );
    });

    it('normalises the email to lower case before writing', async () => {
      mockAuthConfig.registrationEnabled = true;
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      mockAuthRepository.findAnyUserAndCreate.mockResolvedValueOnce({ user: mockUser, firstUser: false });

      await service.register({ ...dto, email: '  Mixed@Example.COM ' });

      expect(mockAuthRepository.findUserByEmail).toHaveBeenCalledWith('mixed@example.com');
      expect(mockAuthRepository.findAnyUserAndCreate).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'mixed@example.com' }),
        { allowWhenUsersExist: true },
      );
    });

    it('rejects a case-variant duplicate when registration is open', async () => {
      mockAuthConfig.registrationEnabled = true;
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce({ id: 'existing' });

      await expect(service.register({ ...dto, email: 'LATE@example.com' }))
        .rejects.toBeInstanceOf(ConflictAppException);

      expect(mockAuthRepository.findAnyUserAndCreate).not.toHaveBeenCalled();
    });

    it('maps a unique violation from the locked create to a conflict', async () => {
      mockAuthConfig.registrationEnabled = true;
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      mockAuthRepository.findAnyUserAndCreate.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002', clientVersion: 'test', meta: { target: ['email'] },
        }),
      );

      await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictAppException);
    });
  });

  describe('registrationStatus', () => {
    it('is open on an empty user table even when the flag is off', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce(null);
      expect(await service.registrationStatus()).toEqual({ open: true });
    });

    it('is closed when users exist and the flag is off', async () => {
      mockAuthRepository.findAnyUser.mockResolvedValueOnce({ id: 'u1' });
      expect(await service.registrationStatus()).toEqual({ open: false });
    });

    it('is open when the flag is on', async () => {
      mockAuthConfig.registrationEnabled = true;
      expect(await service.registrationStatus()).toEqual({ open: true });
    });
  });

  describe('login', () => {
    it('should return tokens for valid credentials', async () => {
      const password = 'Password123!';
      const hashedPassword = await bcrypt.hash(password, 12);
      const userWithHash = { ...mockUser, passwordHash: hashedPassword };

      mockAuthRepository.findUserByEmail.mockResolvedValue(userWithHash);

      const result = await service.login({
        email: mockUser.email,
        password,
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(mockUser.email);
    });

    it('should throw 401 error for invalid password', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValue(mockUser);

      await expect(
        service.login({
          email: mockUser.email,
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(AppException);
    });

    it('should throw 401 error for non-existent user', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'nonexistent@example.com',
          password: 'Password123!',
        }),
      ).rejects.toThrow(AppException);
    });
  });

  describe('refresh', () => {
    it('should return new tokens with valid refresh token', async () => {
      mockAuthRepository.findUserById.mockResolvedValue(mockUser);

      const result = await service.refresh({
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: [],
        extra: {},
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('user');
    });
  });

  describe('refresh (H1)', () => {
    it('throws AuthException when the refresh token is revoked (pre-logout tokenVersion)', async () => {
      const principal = {
        id: 'user-1', name: 'u', blacklisted: false, revoked: true, authorities: [],
      } as unknown as IPrincipal;
      await expect(service.refresh(principal)).rejects.toThrow(AuthException);
    });

    it('still refreshes for a non-revoked principal', async () => {
      mockAuthRepository.findUserById.mockResolvedValue({ id: 'user-1', email: 'e@x', tokenVersion: 3, passwordHash: 'h' });
      const principal = {
        id: 'user-1', name: 'u', blacklisted: false, revoked: false, authorities: [],
      } as unknown as IPrincipal;
      const out = await service.refresh(principal);
      expect(out.accessToken).toBeDefined();
      expect(out.refreshToken).toBeDefined();
    });
  });

  describe('disabled users', () => {
    it('login rejects a disabled user with the same error as a bad password', async () => {
      const passwordHash = await bcrypt.hash('Password123!', 4);
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce({ ...mockUser, passwordHash, disabled: true });

      await expect(service.login({ email: mockUser.email, password: 'Password123!' })).rejects.toBeInstanceOf(AuthException);
    });

    it('refresh refuses to mint tokens for a disabled user', async () => {
      mockAuthRepository.findUserById.mockResolvedValueOnce({ ...mockUser, disabled: true });

      await expect(service.refresh({ id: mockUser.id, revoked: false } as IPrincipal)).rejects.toBeInstanceOf(AuthException);
    });
  });

  describe('validateUser', () => {
    it('should return user for valid principal', async () => {
      mockAuthRepository.findUserById.mockResolvedValue(mockUser);

      const result = await service.validateUser({
        id: mockUser.id,
        name: mockUser.name,
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      });

      expect(result).toEqual(mockUser);
      expect(authRepo.findUserById).toHaveBeenCalledWith(mockUser.id);
    });

    it('should return null if user not found', async () => {
      mockAuthRepository.findUserById.mockResolvedValue(null);

      const result = await service.validateUser({
        id: 'nonexistent-id',
        name: 'nonexistent',
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      });

      expect(result).toBeNull();
    });
  });

  describe('JWT token generation', () => {
    it('should generate access token with correct payload', () => {
      const token = service.generateAccessToken(mockUser.id, mockUser.email, 'MEMBER', mockUser.tokenVersion);

      expect(token).toBe('mock-token');
      expect(mockJwtStrategyProvider.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        role: 'MEMBER',
        tokenVersion: mockUser.tokenVersion,
      });
    });

    it('should generate refresh token', () => {
      const token = service.generateRefreshToken(mockUser.id, mockUser.tokenVersion);

      expect(token).toBe('mock-token');
      expect(mockJwtRefreshStrategyProvider.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        tokenVersion: mockUser.tokenVersion,
      });
    });

    it('should include sub, email, role, and tokenVersion in JWT payload', () => {
      const token = service.generateAccessToken(mockUser.id, mockUser.email, 'ADMIN', 2);

      expect(token).toBe('mock-token');
      const callArgs = (mockJwtStrategyProvider.sign as Mock).mock.calls[0][0];
      expect(callArgs.sub).toBe(mockUser.id);
      expect(callArgs.email).toBe(mockUser.email);
      expect(callArgs.role).toBe('ADMIN');
      expect(callArgs.tokenVersion).toBe(2);
    });
  });

  describe('logout', () => {
    it('should bump the token version and invalidate the cached tokenVersion', async () => {
      mockAuthRepository.bumpTokenVersion.mockResolvedValue(1);

      await service.logout(mockUser.id);

      expect(authRepo.bumpTokenVersion).toHaveBeenCalledWith(mockUser.id);
      expect(mockCacheManager.invalidate).toHaveBeenCalledWith(`USER:${mockUser.id}`, { mode: 'tag' });
      // MEMORY-strategy fallback: the auth state is also evicted by its direct key.
      expect(mockCacheManager.invalidate).toHaveBeenCalledWith(['user-auth-state', mockUser.id]);
    });
  });
});
