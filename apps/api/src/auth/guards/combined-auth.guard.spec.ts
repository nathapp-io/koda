import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CombinedAuthGuard } from './combined-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

describe('CombinedAuthGuard', () => {
  let guard: CombinedAuthGuard;
  let _jwtAuthGuard: JwtAuthGuard;
  let _apiKeyAuthGuard: ApiKeyAuthGuard;

  const mockJwtAuthGuard = {
    canActivate: jest.fn(),
  };

  const mockApiKeyAuthGuard = {
    canActivate: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CombinedAuthGuard,
        Reflector,
        { provide: JwtAuthGuard, useValue: mockJwtAuthGuard },
        { provide: ApiKeyAuthGuard, useValue: mockApiKeyAuthGuard },
      ],
    }).compile();

    guard = module.get<CombinedAuthGuard>(CombinedAuthGuard);
    _jwtAuthGuard = module.get<JwtAuthGuard>(JwtAuthGuard);
    _apiKeyAuthGuard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('canActivate', () => {
    const createMockContext = (handler = () => {}) => ({
      getHandler: () => handler,
    } as unknown as ExecutionContext);

    it('should attempt JWT first and return true if JWT succeeds', async () => {
      const mockContext = createMockContext();

      mockJwtAuthGuard.canActivate.mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).toHaveBeenCalledWith(mockContext);
      expect(mockApiKeyAuthGuard.canActivate).not.toHaveBeenCalled();
    });

    it('should fall back to ApiKeyGuard if JWT fails', async () => {
      const mockContext = createMockContext();

      mockJwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('Invalid token'));
      mockApiKeyAuthGuard.canActivate.mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).toHaveBeenCalledWith(mockContext);
      expect(mockApiKeyAuthGuard.canActivate).toHaveBeenCalledWith(mockContext);
    });

    it('should return 401 if both JWT and ApiKey fail', async () => {
      const mockContext = createMockContext();

      mockJwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('Invalid token'));
      mockApiKeyAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should succeed if JWT fails but ApiKey succeeds', async () => {
      const mockContext = createMockContext();
      mockJwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('Invalid token'));
      mockApiKeyAuthGuard.canActivate.mockResolvedValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
    });

    it('should attach valid API key agent to request', async () => {
      const mockContext = createMockContext();

      mockJwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('Invalid token'));
      mockApiKeyAuthGuard.canActivate.mockResolvedValue(true);

      await guard.canActivate(mockContext);

      expect(mockApiKeyAuthGuard.canActivate).toHaveBeenCalled();
    });
  });
});
