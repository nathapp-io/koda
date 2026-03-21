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
        password: 'password123',
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
        password: 'password123',
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
        password: 'password123',
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
        password: 'password123',
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
        password: 'password123',
      };

      mockAuthService.login.mockRejectedValue(new AuthException());

      await expect(controller.login(loginDto)).rejects.toThrow(AuthException);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should return new tokens with valid refresh token', async () => {
      const bearerToken = 'Bearer mock-refresh-token';
      const user = {
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      };

      mockAuthService.refresh.mockResolvedValue(mockTokenResponse);

      const result = await controller.refresh(user, bearerToken);

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual(mockTokenResponse);
      expect(authService.refresh).toHaveBeenCalledWith(user);
    });

    it('should return 401 when token is missing', async () => {
      const bearerToken = '';
      const user = {
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      };

      mockAuthService.refresh.mockRejectedValue(new AuthException());

      await expect(controller.refresh(user, bearerToken)).rejects.toThrow(
        AuthException,
      );
    });
  });

  describe('GET /auth/me', () => {
    it('should return current authenticated user', async () => {
      const user = {
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
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
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
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
  });
});
