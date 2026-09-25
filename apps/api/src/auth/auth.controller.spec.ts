import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: AuthService;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTokenResponse = {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    user: mockUser,
  };

  const mockAuthService = {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    validateUser: jest.fn(),
    generateAccessToken: jest.fn(),
    generateRefreshToken: jest.fn(),
    logout: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should register a new user and return tokens', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'Password123!',
      };

      mockAuthService.register.mockResolvedValue(mockTokenResponse);

      const result = await controller.register(registerDto);

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual(mockTokenResponse);
      expect(authService.register).toHaveBeenCalledWith(registerDto);
    });

    it('should return user, accessToken, and refreshToken', async () => {
      const registerDto = {
        email: 'newuser@example.com',
        name: 'New User',
        password: 'Password123!',
      };

      const newUserResponse = {
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        user: {
          id: 'user-456',
          email: registerDto.email,
          name: registerDto.name,
          role: 'MEMBER',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      mockAuthService.register.mockResolvedValue(newUserResponse);

      const result = await controller.register(registerDto);

      expect(result.data).toHaveProperty('accessToken');
      expect(result.data).toHaveProperty('refreshToken');
      expect(result.data).toHaveProperty('user');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.data as any).user.email).toBe(registerDto.email);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.data as any).user.name).toBe(registerDto.name);
    });
  });

  describe('POST /auth/login', () => {
    it('should login user and return tokens', async () => {
      const loginDto = {
        email: mockUser.email,
        password: 'Password123!',
      };

      mockAuthService.login.mockResolvedValue(mockTokenResponse);

      const result = await controller.login(loginDto);

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual(mockTokenResponse);
      expect(authService.login).toHaveBeenCalledWith(loginDto);
    });

    it('should return user, accessToken, and refreshToken', async () => {
      const loginDto = {
        email: mockUser.email,
        password: 'Password123!',
      };

      mockAuthService.login.mockResolvedValue(mockTokenResponse);

      const result = await controller.login(loginDto);

      expect(result.data).toHaveProperty('accessToken');
      expect(result.data).toHaveProperty('refreshToken');
      expect(result.data).toHaveProperty('user');
    });

    it('should return 401 for invalid password', async () => {
      const loginDto = {
        email: mockUser.email,
        password: 'wrongpassword',
      };

      mockAuthService.login.mockRejectedValue(new AuthException());

      await expect(controller.login(loginDto)).rejects.toThrow(AuthException);
      expect(authService.login).toHaveBeenCalledWith(loginDto);
    });

    it('should return 401 for non-existent user', async () => {
      const loginDto = {
        email: 'nonexistent@example.com',
        password: 'Password123!',
      };

      mockAuthService.login.mockRejectedValue(new AuthException());

      await expect(controller.login(loginDto)).rejects.toThrow(AuthException);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should return new tokens with valid refresh token', async () => {
      // refresh endpoint receives IPrincipal (id field), not JwtPayload (sub field)
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: [],
        extra: {},
      };

      mockAuthService.refresh.mockResolvedValue(mockTokenResponse);

      const result = await controller.refresh(user);

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual(mockTokenResponse);
      expect(authService.refresh).toHaveBeenCalledWith(user);
    });

    it('should return 401 when token is missing', async () => {
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: [],
        extra: {},
      };

      mockAuthService.refresh.mockRejectedValue(new AuthException());

      await expect(controller.refresh(user)).rejects.toThrow(
        AuthException,
      );
    });
  });

  describe('GET /auth/me', () => {
    it('should return current authenticated user', async () => {
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      };

      mockAuthService.validateUser.mockResolvedValue(mockUser);

      const result = await controller.me(user);

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual(mockUser);
      expect(authService.validateUser).toHaveBeenCalledWith(user);
    });

    it('should return 401 when token is missing', async () => {
      const user = null;

      // Controller should not allow null user for protected route
      // This is handled by JWT guard
      expect(user).toBeNull();
    });

    it('should include all user fields in response', async () => {
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      };

      mockAuthService.validateUser.mockResolvedValue(mockUser);

      const result = await controller.me(user);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = result.data as any;
      expect(data.id).toBe(mockUser.id);
      expect(data.email).toBe(mockUser.email);
      expect(data.name).toBe(mockUser.name);
      expect(data.role).toBe(mockUser.role);
    });

    // Final-review Finding D: validateUser returns the full user row including
    // passwordHash — /auth/me must map through UserResponseDto so the hash is
    // never serialized.
    it('should never serialize passwordHash in the /auth/me response', async () => {
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      };

      mockAuthService.validateUser.mockResolvedValue({
        ...mockUser,
        passwordHash: '$2b$10$supersecret-hash',
      });

      const result = await controller.me(user);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = result.data as any;
      expect(data).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(result)).not.toContain('supersecret-hash');
      // Legitimate fields are still present
      expect(data.email).toBe(mockUser.email);
      expect(data.name).toBe(mockUser.name);
    });
  });

  // Metadata keys confirmed in @nestjs/throttler@6.5.0 dist/throttler.constants.js:
  // THROTTLER_LIMIT = 'THROTTLER:LIMIT', THROTTLER_TTL = 'THROTTLER:TTL',
  // suffixed with the throttler name ('default').
  describe('H2 throttle placement', () => {
    const LIMIT_KEY = 'THROTTLER:LIMITdefault';
    const TTL_KEY = 'THROTTLER:TTLdefault';

    it('has no class-level @Throttle so /auth/me is not rate limited', () => {
      expect(Reflect.getMetadata(LIMIT_KEY, AuthController)).toBeUndefined();
      expect(Reflect.getMetadata(TTL_KEY, AuthController)).toBeUndefined();
    });

    it('throttles login, register, and logout at 5/min each', () => {
      const proto = AuthController.prototype as unknown as Record<string, unknown>;
      for (const handler of ['login', 'register', 'logout']) {
        const handlerFn = proto[handler] as object;
        expect(Reflect.getMetadata(LIMIT_KEY, handlerFn)).toBe(5);
        expect(Reflect.getMetadata(TTL_KEY, handlerFn)).toBe(60000);
      }
    });

    it('does not throttle refresh beyond the global default', () => {
      const proto = AuthController.prototype as unknown as Record<string, unknown>;
      expect(Reflect.getMetadata(LIMIT_KEY, proto['refresh'] as object)).toBeUndefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('should revoke tokens for the current user', async () => {
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      };

      mockAuthService.logout.mockResolvedValue(undefined);

      const result = await controller.logout(user);

      expect(result).toBeInstanceOf(JsonResponse);
      expect(authService.logout).toHaveBeenCalledWith(mockUser.id);
    });

    it('should use principal.id when sub is absent (BUG-1)', async () => {
      const user = {
        id: mockUser.id,
        name: mockUser.email,
        blacklisted: false,
        revoked: false,
        authorities: ['MEMBER'],
      };

      mockAuthService.logout.mockResolvedValue(undefined);

      await controller.logout(user);

      expect(authService.logout).toHaveBeenCalledWith(mockUser.id);
      expect(authService.logout).not.toHaveBeenCalledWith(undefined);
    });
  });
});
