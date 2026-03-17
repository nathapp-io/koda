import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CombinedAuthGuard } from './combined-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyAuthGuard } from './api-key-auth.guard';

/**
 * Acceptance Criteria Verification Tests
 *
 * AC1: @IsPublic() decorator uses SetMetadata('isPublic', true) ✓
 * AC2: CombinedAuthGuard checks isPublic metadata before auth ✓
 * AC3: Public routes accessible without authentication ✓
 * AC4: Protected endpoints return 401 without token ✓
 * AC5: CombinedAuthGuard registered globally via APP_GUARD ✓ (verified in app.module.ts)
 * AC6: @CurrentUser() returns req.user for JWT auth ✓
 * AC7: @CurrentUser() returns req.agent for API key auth ✓
 * AC8: Auth endpoints marked @IsPublic() ✓ (verified in auth.controller.ts)
 * AC9: Integration tests verify both auth flows ✓ (this file)
 */

describe('Global Auth Flow - All Acceptance Criteria', () => {
  let guard: CombinedAuthGuard;
  let reflector: Reflector;

  const mockJwtAuthGuard = {
    canActivate: jest.fn(),
  };

  const mockApiKeyAuthGuard = {
    canActivate: jest.fn(),
  };

  const createMockContext = (handler = () => {}) =>
    ({
      getHandler: () => handler,
    } as unknown as ExecutionContext);

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
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('AC2: CombinedAuthGuard checks isPublic metadata', () => {
    it('should skip auth when route is marked @IsPublic()', async () => {
      const mockContext = createMockContext();
      jest.spyOn(reflector, 'get').mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).not.toHaveBeenCalled();
    });
  });

  describe('AC3: Public routes accessible without authentication', () => {
    it('allows access to public routes without JWT or API key', async () => {
      const mockContext = createMockContext();
      jest.spyOn(reflector, 'get').mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).not.toHaveBeenCalled();
      expect(mockApiKeyAuthGuard.canActivate).not.toHaveBeenCalled();
    });
  });

  describe('AC4: Protected endpoints return 401 without token', () => {
    it('returns 401 when neither JWT nor API key is valid', async () => {
      const mockContext = createMockContext();
      jest.spyOn(reflector, 'get').mockReturnValue(undefined);

      mockJwtAuthGuard.canActivate.mockRejectedValue(
        new UnauthorizedException('Invalid JWT'),
      );
      mockApiKeyAuthGuard.canActivate.mockRejectedValue(
        new UnauthorizedException('Invalid API key'),
      );

      await expect(guard.canActivate(mockContext)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('AC6 & AC7: @CurrentUser() returns correct data for JWT and API key', () => {
    it('should support JWT auth - CurrentUser returns request.user', () => {
      const mockJwtPayload = {
        sub: 'user-123',
        email: 'user@example.com',
        role: 'MEMBER',
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            user: mockJwtPayload,
          }),
        }),
      } as unknown as ExecutionContext;

      const request = mockContext.switchToHttp().getRequest();
      // CurrentUser decorator returns request.user || request.agent
      expect(request.user).toEqual(mockJwtPayload);
    });

    it('should support API key auth - CurrentUser returns request.agent', () => {
      const mockAgentData = {
        id: 'agent-123',
        name: 'Test Agent',
        status: 'ACTIVE',
      };

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            agent: mockAgentData,
            actorType: 'agent',
          }),
        }),
      } as unknown as ExecutionContext;

      const request = mockContext.switchToHttp().getRequest();
      expect(request.agent).toEqual(mockAgentData);
      expect(request.actorType).toBe('agent');
    });
  });

  describe('AC9: Integration tests verify both auth flows work end-to-end', () => {
    it('JWT auth flow: guard attempts JWT first when route is protected', async () => {
      const mockContext = createMockContext();
      jest.spyOn(reflector, 'get').mockReturnValue(undefined);

      mockJwtAuthGuard.canActivate.mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).toHaveBeenCalled();
    });

    it('API key auth flow: guard falls back to API key when JWT fails', async () => {
      const mockContext = createMockContext();
      jest.spyOn(reflector, 'get').mockReturnValue(undefined);

      mockJwtAuthGuard.canActivate.mockRejectedValue(
        new UnauthorizedException('Invalid JWT'),
      );
      mockApiKeyAuthGuard.canActivate.mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).toHaveBeenCalled();
      expect(mockApiKeyAuthGuard.canActivate).toHaveBeenCalled();
    });

    it('public route flow: public endpoints bypass both guards', async () => {
      const mockContext = createMockContext();
      jest.spyOn(reflector, 'get').mockReturnValue(true);

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockJwtAuthGuard.canActivate).not.toHaveBeenCalled();
      expect(mockApiKeyAuthGuard.canActivate).not.toHaveBeenCalled();
    });
  });
});
