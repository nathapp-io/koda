import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService, CreateAgentDto as _CreateAgentDto } from './agents.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { randomBytes } from 'crypto';

describe('AgentsService', () => {
  let service: AgentsService;
  let prismaService: PrismaService;
  let _configService: ConfigService;

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
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AgentsService>(AgentsService);
    prismaService = module.get<PrismaService>(PrismaService);
    _configService = module.get<ConfigService>(ConfigService);

    mockConfigService.get.mockReturnValue('test-secret');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateApiKey', () => {
    it('should generate random 32-byte hex key', async () => {
      const _agentId = 'agent-123';
      mockPrismaService.agent.create.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      const result = await service.generateApiKey({
        name: 'Test Agent',
        slug: 'test-agent',
      });

      expect(result).toHaveProperty('apiKey');
      expect(typeof result.apiKey).toBe('string');
      // 32 bytes = 64 hex characters
      expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should store HMAC-SHA256 hash in database', async () => {
      mockPrismaService.agent.create.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      const result = await service.generateApiKey({
        name: 'Test Agent',
        slug: 'test-agent',
      });

      expect(prismaService.agent.create).toHaveBeenCalled();
      const createCall = (prismaService.agent.create as jest.Mock).mock.calls[0][0];

      const expectedHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
      expect(createCall.data.apiKeyHash).toBe(expectedHash);
    });

    it('should return raw key ONCE to client', async () => {
      const rawKey = randomBytes(32).toString('hex');

      const agentWithHash = {
        ...mockAgent,
        apiKeyHash: createHmac('sha256', 'test-secret').update(rawKey).digest('hex'),
      };
      mockPrismaService.agent.create.mockResolvedValue(agentWithHash);
      mockConfigService.get.mockReturnValue('test-secret');

      const result = await service.generateApiKey({
        name: 'Test Agent',
        slug: 'test-agent',
      });

      expect(result).toHaveProperty('apiKey');
      expect(result.apiKey).toBeDefined();
      expect(result.apiKey).not.toBe(agentWithHash.apiKeyHash);
    });

    it('should include agentId in create call', async () => {
      mockPrismaService.agent.create.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      await service.generateApiKey({
        name: 'Test Agent',
        slug: 'test-agent',
      });

      expect(prismaService.agent.create).toHaveBeenCalled();
      const createCall = (prismaService.agent.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.name).toBe('Test Agent');
      expect(createCall.data.slug).toBe('test-agent');
    });

    it('should use API_KEY_SECRET for hashing', async () => {
      const secret = 'my-custom-secret';
      mockPrismaService.agent.create.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue(secret);

      const result = await service.generateApiKey({
        name: 'Test Agent',
        slug: 'test-agent',
      });

      const expectedHash = createHmac('sha256', secret).update(result.apiKey).digest('hex');

      const createCall = (prismaService.agent.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.apiKeyHash).toBe(expectedHash);
    });
  });
});
