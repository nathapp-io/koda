import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService, CreateAgentDto as _CreateAgentDto } from './agents.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { NotFoundException as _NotFoundException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { randomBytes } from 'crypto';

describe('AgentsService', () => {
  let service: AgentsService;
  let prismaService: PrismaService<PrismaClient>;
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

  const mockAgentWithRelations = {
    ...mockAgent,
    roles: [
      { id: 'role-1', agentId: 'agent-123', role: 'DEVELOPER' },
    ],
    capabilities: [
      { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
      { id: 'cap-2', agentId: 'agent-123', capability: 'nestjs' },
    ],
  };

  const mockPrismaService = {
  client: {
      agent: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      agentRoleEntry: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      agentCapabilityEntry: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
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
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);
    _configService = module.get<ConfigService>(ConfigService);

    mockConfigService.get.mockReturnValue('test-secret');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateApiKey', () => {
    describe('for new agent creation', () => {
      it('should generate random 32-byte hex key', async () => {
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
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

      it('should compute HMAC-SHA256 hash with API_KEY_SECRET', async () => {
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(prismaService.client.agent.create).toHaveBeenCalled();
        const createCall = (prismaService.client.agent.create as jest.Mock).mock.calls[0][0];

        const expectedHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
        expect(createCall.data.apiKeyHash).toBe(expectedHash);
      });

      it('should return raw key ONCE to client (not stored)', async () => {
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(result).toHaveProperty('apiKey');
        expect(result.apiKey).toBeDefined();
        expect(result.apiKey).not.toBe(mockAgent.apiKeyHash);
      });

      it('should store only hash in database', async () => {
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        const createCall = (prismaService.client.agent.create as jest.Mock).mock.calls[0][0];

        // Should NOT store raw key
        expect(createCall.data.apiKeyHash).not.toBe(result.apiKey);
        expect(createCall.data.apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
      });

      it('should include agent name and slug in creation', async () => {
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(prismaService.client.agent.create).toHaveBeenCalled();
        const createCall = (prismaService.client.agent.create as jest.Mock).mock.calls[0][0];
        expect(createCall.data.name).toBe('Test Agent');
        expect(createCall.data.slug).toBe('test-agent');
      });

      it('should use correct API_KEY_SECRET from config', async () => {
        const secret = 'my-custom-secret';
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue(secret);

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        const expectedHash = createHmac('sha256', secret).update(result.apiKey).digest('hex');

        const createCall = (prismaService.client.agent.create as jest.Mock).mock.calls[0][0];
        expect(createCall.data.apiKeyHash).toBe(expectedHash);
      });

      it('should throw error when API_KEY_SECRET is not configured', async () => {
        mockConfigService.get.mockReturnValue(null);

        await expect(service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        })).rejects.toThrow('API_KEY_SECRET is not configured');
      });

      it('should return created agent in response', async () => {
        mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(result.agent).toEqual(mockAgent);
        expect(result.agent.id).toBe('agent-123');
      });
    });

    describe('for rotating existing agent key', () => {
      it('should generate new random API key', async () => {
        mockPrismaService.client.agent.update.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey('agent-123');

        expect(result).toHaveProperty('apiKey');
        expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
      });

      it('should replace old API key hash with new one', async () => {
        const oldHash = 'old-hashed-key';
        const agentWithOldHash = { ...mockAgent, apiKeyHash: oldHash };

        mockPrismaService.client.agent.update.mockResolvedValue(agentWithOldHash);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey('agent-123');

        expect(prismaService.client.agent.update).toHaveBeenCalled();
        const updateCall = (prismaService.client.agent.update as jest.Mock).mock.calls[0][0];

        const newHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
        expect(updateCall.data.apiKeyHash).toBe(newHash);
        expect(updateCall.data.apiKeyHash).not.toBe(oldHash);
      });

      it('should invalidate old API key', async () => {
        const oldKey = randomBytes(32).toString('hex');
        const oldHash = createHmac('sha256', 'test-secret').update(oldKey).digest('hex');

        const agentWithOldKey = { ...mockAgent, apiKeyHash: oldHash };
        mockPrismaService.client.agent.update.mockResolvedValue(agentWithOldKey);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey('agent-123');

        // New hash should not match old key
        const newHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
        expect(newHash).not.toBe(oldHash);
      });

      it('should return new raw key ONCE', async () => {
        mockPrismaService.client.agent.update.mockResolvedValue(mockAgent);
        mockConfigService.get.mockReturnValue('test-secret');

        const result = await service.generateApiKey('agent-123');

        expect(result.apiKey).toBeDefined();
        expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
      });
    });
  });

  describe('findAll', () => {
    it('should return all agents with roles and capabilities', async () => {
      const agents = [mockAgentWithRelations];
      mockPrismaService.client.agent.findMany.mockResolvedValue(agents);

      const result = await service.findAll();

      expect(result).toEqual(agents);
      expect(prismaService.client.agent.findMany).toHaveBeenCalled();
    });

    it('should include role entries for each agent', async () => {
      const agents = [mockAgentWithRelations];
      mockPrismaService.client.agent.findMany.mockResolvedValue(agents);

      const result = await service.findAll();

      expect(result[0].roles).toBeDefined();
      expect(Array.isArray(result[0].roles)).toBe(true);
      expect(result[0].roles.length).toBe(1);
    });

    it('should include capability entries for each agent', async () => {
      const agents = [mockAgentWithRelations];
      mockPrismaService.client.agent.findMany.mockResolvedValue(agents);

      const result = await service.findAll();

      expect(result[0].capabilities).toBeDefined();
      expect(Array.isArray(result[0].capabilities)).toBe(true);
      expect(result[0].capabilities.length).toBe(2);
    });

    it('should return empty array when no agents exist', async () => {
      mockPrismaService.client.agent.findMany.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toEqual([]);
    });

    it('should fetch agents with related roles and capabilities', async () => {
      const agents = [mockAgentWithRelations];
      mockPrismaService.client.agent.findMany.mockResolvedValue(agents);

      await service.findAll();

      expect(prismaService.client.agent.findMany).toHaveBeenCalledWith({
        include: {
          roles: true,
          capabilities: true,
        },
      });
    });
  });

  describe('findBySlug', () => {
    it('should return agent by slug with roles and capabilities', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findBySlug('test-agent');

      expect(result).toEqual(mockAgentWithRelations);
      expect(prismaService.client.agent.findUnique).toHaveBeenCalledWith({
        where: { slug: 'test-agent' },
        include: {
          roles: true,
          capabilities: true,
        },
      });
    });

    it('should throw when agent not found', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(null);

      await expect(service.findBySlug('nonexistent')).rejects.toThrow();
    });

    it('should include roles in response', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findBySlug('test-agent');

      expect(result.roles).toBeDefined();
      expect(Array.isArray(result.roles)).toBe(true);
    });

    it('should include capabilities in response', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findBySlug('test-agent');

      expect(result.capabilities).toBeDefined();
      expect(Array.isArray(result.capabilities)).toBe(true);
    });
  });

  describe('findMe', () => {
    it('should return authenticated agent profile by id', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findMe('agent-123');

      expect(result).toEqual(mockAgentWithRelations);
      expect(prismaService.client.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'agent-123' },
        include: {
          roles: true,
          capabilities: true,
        },
      });
    });

    it('should include roles with all AgentRole enum values', async () => {
      const agentWithAllRoles = {
        ...mockAgentWithRelations,
        roles: [
          { id: 'role-1', agentId: 'agent-123', role: 'TRIAGER' },
          { id: 'role-2', agentId: 'agent-123', role: 'DEVELOPER' },
          { id: 'role-3', agentId: 'agent-123', role: 'REVIEWER' },
        ],
      };

      mockPrismaService.client.agent.findUnique.mockResolvedValue(agentWithAllRoles);

      const result = await service.findMe('agent-123');

      expect(result.roles.length).toBe(3);
      expect(result.roles.map((r: any) => r.role)).toContain('TRIAGER');
      expect(result.roles.map((r: any) => r.role)).toContain('DEVELOPER');
      expect(result.roles.map((r: any) => r.role)).toContain('REVIEWER');
    });

    it('should include capabilities', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findMe('agent-123');

      expect(result.capabilities).toBeDefined();
      expect(result.capabilities.length).toBe(2);
    });

    it('should throw error when agent not found', async () => {
      mockPrismaService.client.agent.findUnique.mockResolvedValue(null);

      await expect(service.findMe('nonexistent')).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should update agent with basic fields', async () => {
      const updateData = {
        name: 'Updated Agent',
        maxConcurrentTickets: 5,
      };

      const updatedAgent = { ...mockAgent, ...updateData };
      mockPrismaService.client.agent.update.mockResolvedValue(updatedAgent);

      const result = await service.update('test-agent', updateData);

      expect(result.name).toBe('Updated Agent');
      expect(result.maxConcurrentTickets).toBe(5);
    });

    it('should update agent status', async () => {
      const updateData = { status: 'PAUSED' };
      const updatedAgent = { ...mockAgent, status: 'PAUSED' };
      mockPrismaService.client.agent.update.mockResolvedValue(updatedAgent);

      const result = await service.update('test-agent', updateData);

      expect(result.status).toBe('PAUSED');
    });

    it('should throw error when agent not found', async () => {
      mockPrismaService.client.agent.update.mockRejectedValue(new Error('Agent not found'));

      await expect(service.update('nonexistent', { name: 'New Name' })).rejects.toThrow();
    });
  });

  describe('updateRoles', () => {
    it('should delete all existing roles and insert new ones', async () => {
      const updateData = { roles: ['DEVELOPER', 'REVIEWER'] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        roles: [
          { id: 'new-role-1', agentId: 'agent-123', role: 'DEVELOPER' },
          { id: 'new-role-2', agentId: 'agent-123', role: 'REVIEWER' },
        ],
      };

      mockPrismaService.client.agentRoleEntry.deleteMany.mockResolvedValue({ count: 1 });
      mockPrismaService.client.agentRoleEntry.createMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateRoles('agent-123', updateData);

      expect(prismaService.client.agentRoleEntry.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123' },
      });

      expect(prismaService.client.agentRoleEntry.createMany).toHaveBeenCalled();
      expect(result.roles.length).toBe(2);
      expect(result.roles.map((r: any) => r.role)).toEqual(['DEVELOPER', 'REVIEWER']);
    });

    it('should REPLACE roles, not append', async () => {
      const updateData = { roles: ['TRIAGER'] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        roles: [
          { id: 'new-role-1', agentId: 'agent-123', role: 'TRIAGER' },
        ],
      };

      mockPrismaService.client.agentRoleEntry.deleteMany.mockResolvedValue({ count: 1 });
      mockPrismaService.client.agentRoleEntry.createMany.mockResolvedValue({ count: 1 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateRoles('agent-123', updateData);

      // Verify delete was called (removes old roles)
      expect(prismaService.client.agentRoleEntry.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123' },
      });

      // Verify only new role exists
      expect(result.roles.length).toBe(1);
      expect(result.roles[0].role).toBe('TRIAGER');
    });

    it('should allow updating to empty roles array', async () => {
      const updateData = { roles: [] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        roles: [],
      };

      mockPrismaService.client.agentRoleEntry.deleteMany.mockResolvedValue({ count: 1 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateRoles('agent-123', updateData);

      expect(result.roles.length).toBe(0);
    });
  });

  describe('updateCapabilities', () => {
    it('should delete all existing capabilities and insert new ones', async () => {
      const updateData = { capabilities: ['typescript', 'react', 'nodejs'] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        capabilities: [
          { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
          { id: 'cap-2', agentId: 'agent-123', capability: 'react' },
          { id: 'cap-3', agentId: 'agent-123', capability: 'nodejs' },
        ],
      };

      mockPrismaService.client.agentCapabilityEntry.deleteMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agentCapabilityEntry.createMany.mockResolvedValue({ count: 3 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(prismaService.client.agentCapabilityEntry.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123' },
      });

      expect(prismaService.client.agentCapabilityEntry.createMany).toHaveBeenCalled();
      expect(result.capabilities.length).toBe(3);
      expect(result.capabilities.map((c: any) => c.capability)).toEqual(['typescript', 'react', 'nodejs']);
    });

    it('should REPLACE capabilities, not append', async () => {
      const updateData = { capabilities: ['golang', 'python'] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        capabilities: [
          { id: 'cap-1', agentId: 'agent-123', capability: 'golang' },
          { id: 'cap-2', agentId: 'agent-123', capability: 'python' },
        ],
      };

      mockPrismaService.client.agentCapabilityEntry.deleteMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agentCapabilityEntry.createMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(prismaService.client.agentCapabilityEntry.deleteMany).toHaveBeenCalledWith({
        where: { agentId: 'agent-123' },
      });

      expect(result.capabilities.length).toBe(2);
      expect(result.capabilities.map((c: any) => c.capability)).toEqual(['golang', 'python']);
    });

    it('should allow updating to empty capabilities array', async () => {
      const updateData = { capabilities: [] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        capabilities: [],
      };

      mockPrismaService.client.agentCapabilityEntry.deleteMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(result.capabilities.length).toBe(0);
    });

    it('should handle duplicate capabilities gracefully', async () => {
      const updateData = { capabilities: ['typescript', 'typescript', 'react'] };
      // Prisma unique constraint should handle this, but we test graceful handling
      const updatedAgent = {
        ...mockAgentWithRelations,
        capabilities: [
          { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
          { id: 'cap-2', agentId: 'agent-123', capability: 'react' },
        ],
      };

      mockPrismaService.client.agentCapabilityEntry.deleteMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agentCapabilityEntry.createMany.mockResolvedValue({ count: 2 });
      mockPrismaService.client.agent.findUnique.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(result.capabilities.length).toBe(2);
    });
  });

  describe('rotateApiKey', () => {
    it('should generate new API key for agent', async () => {
      mockPrismaService.client.agent.update.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      const result = await service.rotateApiKey('agent-123');

      expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should invalidate old API key', async () => {
      const oldHash = 'old-hashed-key';
      const agentWithOldHash = { ...mockAgent, apiKeyHash: oldHash };

      mockPrismaService.client.agent.update.mockResolvedValue(agentWithOldHash);
      mockConfigService.get.mockReturnValue('test-secret');

      const result = await service.rotateApiKey('agent-123');

      const newHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
      expect(newHash).not.toBe(oldHash);
    });

    it('should return raw key ONCE', async () => {
      mockPrismaService.client.agent.update.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      const result = await service.rotateApiKey('agent-123');

      expect(result.apiKey).toBeDefined();
      expect(result.apiKey).not.toBe(mockAgent.apiKeyHash);
    });

    it('should throw error when agent not found', async () => {
      mockPrismaService.client.agent.update.mockRejectedValue(new Error('Agent not found'));
      mockConfigService.get.mockReturnValue('test-secret');

      await expect(service.rotateApiKey('nonexistent')).rejects.toThrow();
    });
  });

  describe('API Key Validation', () => {
    it('should generate unique API keys on multiple calls', async () => {
      mockPrismaService.client.agent.create.mockResolvedValue(mockAgent);
      mockConfigService.get.mockReturnValue('test-secret');

      const result1 = await service.generateApiKey({
        name: 'Agent 1',
        slug: 'agent-1',
      });

      const result2 = await service.generateApiKey({
        name: 'Agent 2',
        slug: 'agent-2',
      });

      // Raw keys should be different
      expect(result1.apiKey).not.toBe(result2.apiKey);
    });

    it('should produce deterministic hashes for same key and secret', async () => {
      const testKey = 'a'.repeat(64);
      const secret = 'test-secret';

      const hash1 = createHmac('sha256', secret).update(testKey).digest('hex');
      const hash2 = createHmac('sha256', secret).update(testKey).digest('hex');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different secrets', async () => {
      const testKey = 'a'.repeat(64);

      const hash1 = createHmac('sha256', 'secret1').update(testKey).digest('hex');
      const hash2 = createHmac('sha256', 'secret2').update(testKey).digest('hex');

      expect(hash1).not.toBe(hash2);
    });
  });
});
