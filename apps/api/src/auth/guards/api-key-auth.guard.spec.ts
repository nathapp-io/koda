import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let prismaService: PrismaService;
  let configService: ConfigService;

  const mockAgent = {
    id: 'agent-123',
    name: 'Test Agent',
    slug: 'test-agent',
    apiKeyHash: 'hashed-key',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    agent: {
      findUnique: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthGuard,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    guard = module.get<ApiKeyAuthGuard>(ApiKeyAuthGuard);
    prismaService = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);

    mockConfigService.get.mockReturnValue('test-secret');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('canActivate', () => {
    it('should extract Bearer token from Authorization header', async () => {
      const rawKey = 'test-api-key';

      const mockRequest: any = {
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      };

      mockPrismaService.agent.findUnique.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(mockRequest.agent).toEqual(mockAgent);
      expect(mockRequest.actorType).toBe('agent');
    });

    it('should compute HMAC-SHA256 hash with API_KEY_SECRET', async () => {
      const rawKey = 'test-api-key';
      const secret = 'my-secret-key';
      const hash = createHmac('sha256', secret).update(rawKey).digest('hex');
      const agentWithHash = { ...mockAgent, apiKeyHash: hash };

      const mockRequest: any = {
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      };

      mockConfigService.get.mockReturnValue(secret);
      mockPrismaService.agent.findUnique.mockResolvedValue(agentWithHash);

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(mockContext);

      expect(result).toBe(true);
      expect(prismaService.agent.findUnique).toHaveBeenCalledWith({
        where: { apiKeyHash: hash },
      });
    });

    it('should look up Agent by apiKeyHash', async () => {
      const rawKey = 'test-api-key';
      const hash = createHmac('sha256', 'test-secret').update(rawKey).digest('hex');

      const mockRequest: any = {
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      };

      mockPrismaService.agent.findUnique.mockResolvedValue(mockAgent);

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await guard.canActivate(mockContext);

      expect(prismaService.agent.findUnique).toHaveBeenCalledWith({
        where: { apiKeyHash: hash },
      });
    });

    it('should attach agent to request.agent and set request.actorType = "agent"', async () => {
      const rawKey = 'test-api-key';

      const mockRequest: any = {
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      };

      mockPrismaService.agent.findUnique.mockResolvedValue(mockAgent);

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await guard.canActivate(mockContext);

      expect(mockRequest.agent).toEqual(mockAgent);
      expect(mockRequest.actorType).toBe('agent');
    });

    it('should reject PAUSED agent', async () => {
      const rawKey = 'test-api-key';
      const pausedAgent = { ...mockAgent, status: 'PAUSED' };

      const mockRequest: any = {
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      };

      mockPrismaService.agent.findUnique.mockResolvedValue(pausedAgent);

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject OFFLINE agent', async () => {
      const rawKey = 'test-api-key';
      const offlineAgent = { ...mockAgent, status: 'OFFLINE' };

      const mockRequest: any = {
        headers: {
          authorization: `Bearer ${rawKey}`,
        },
      };

      mockPrismaService.agent.findUnique.mockResolvedValue(offlineAgent);

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should return 401 for invalid API key', async () => {
      const mockRequest: any = {
        headers: {
          authorization: 'Bearer invalid-key',
        },
      };

      mockPrismaService.agent.findUnique.mockResolvedValue(null);

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should return 401 when Authorization header is missing', async () => {
      const mockRequest: any = {
        headers: {},
      };

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });

    it('should return 401 when Authorization header does not have Bearer token', async () => {
      const mockRequest: any = {
        headers: {
          authorization: 'Basic dGVzdDp0ZXN0',
        },
      };

      const mockContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(mockContext)).rejects.toThrow(UnauthorizedException);
    });
  });
});
