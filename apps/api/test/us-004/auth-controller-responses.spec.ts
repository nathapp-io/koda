/**
 * US-004 — AuthController response envelope
 *
 * Every controller method must return a JsonResponse instance so callers
 * consistently receive { data, meta?, message? }.
 * These tests are RED until AuthController is updated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';
import { JsonResponse } from '@nathapp/nestjs-common';

describe('AuthController — JsonResponse envelope (US-004)', () => {
  let controller: AuthController;

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    role: 'MEMBER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAuthData = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    user: mockUser,
  };

  const mockAuthService = {
    register: jest.fn().mockResolvedValue(mockAuthData),
    login: jest.fn().mockResolvedValue(mockAuthData),
    refresh: jest.fn().mockResolvedValue(mockAuthData),
    validateUser: jest.fn().mockResolvedValue(mockUser),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /auth/register', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pass123' };
      const result = await controller.register(dto);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps auth data under result.data', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pass123' };
      const result = await controller.register(dto);
      expect((result as unknown as JsonResponse<any>).data).toHaveProperty('accessToken');
      expect((result as unknown as JsonResponse<any>).data).toHaveProperty('refreshToken');
      expect((result as unknown as JsonResponse<any>).data).toHaveProperty('user');
    });
  });

  describe('POST /auth/login', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { email: 'a@b.com', password: 'pass123' };
      const result = await controller.login(dto);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps { accessToken, refreshToken, user } under result.data', async () => {
      const dto = { email: 'a@b.com', password: 'pass123' };
      const result = await controller.login(dto);
      const envelope = result as unknown as JsonResponse<any>;
      expect(envelope.data).toHaveProperty('accessToken');
      expect(envelope.data).toHaveProperty('refreshToken');
      expect(envelope.data).toHaveProperty('user');
    });
  });

  describe('POST /auth/refresh', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.refresh({
        sub: 'user-1',
        email: 'a@b.com',
        role: 'MEMBER',
      }, 'Bearer tok');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps new tokens under result.data', async () => {
      const result = await controller.refresh({
        sub: 'user-1',
        email: 'a@b.com',
        role: 'MEMBER',
      }, 'Bearer tok');
      const envelope = result as unknown as JsonResponse<any>;
      expect(envelope.data).toHaveProperty('accessToken');
      expect(envelope.data).toHaveProperty('refreshToken');
    });
  });

  describe('GET /auth/me', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.me({
        sub: 'user-1',
        email: 'a@b.com',
        role: 'MEMBER',
      });
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps user object under result.data', async () => {
      const result = await controller.me({
        sub: 'user-1',
        email: 'a@b.com',
        role: 'MEMBER',
      });
      const envelope = result as unknown as JsonResponse<any>;
      expect(envelope.data).toHaveProperty('id');
      expect(envelope.data).toHaveProperty('email');
    });
  });
});
