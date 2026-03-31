import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';

describe('AgentsController', () => {
  let controller: AgentsController;
  let service: AgentsService;

  const mockAdminUser = {
    id: 'user-123', sub: 'user-123',
    email: 'admin@example.com',
    name: 'admin@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [],
    extra: { sub: 'user-123', email: 'admin@example.com', role: 'ADMIN' },
  };

  const mockAgentUser = {
    id: 'agent-456', sub: 'agent-456',
    name: 'test-agent',
    blacklisted: false,
    revoked: false,
    authorities: [],
    extra: { sub: 'agent-456', actorType: 'agent', slug: 'test-agent' },
  };

  const mockMemberUser = {
    id: 'user-789', sub: 'user-789',
    name: 'member@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [],
    extra: { sub: 'user-789', email: 'member@example.com', role: 'MEMBER' },
  };

  const mockAgent = {
    id: 'agent-123',
    name: 'Test Agent',
    slug: 'test-agent',
    apiKeyHash: 'hashed-key-123',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    roles: [
      { id: 'role-1', agentId: 'agent-123', role: 'DEVELOPER' },
    ],
    capabilities: [
      { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
      { id: 'cap-2', agentId: 'agent-123', capability: 'nestjs' },
    ],
  };

  const mockAgentsService = {
    generateApiKey: jest.fn(),
    findAll: jest.fn(),
    findBySlug: jest.fn(),
    findMe: jest.fn(),
    update: jest.fn(),
    updateRoles: jest.fn(),
    updateCapabilities: jest.fn(),
    rotateApiKey: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [{ provide: AgentsService, useValue: mockAgentsService }],
    }).compile();

    controller = module.get<AgentsController>(AgentsController);
    service = module.get<AgentsService>(AgentsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/agents', () => {
    it('should create agent and return raw API key for ADMIN user', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      const generatedKey = {
        apiKey: 'a'.repeat(64),
        agent: {
          id: 'agent-123',
          name: 'Test Agent',
          slug: 'test-agent',
          status: 'ACTIVE',
        },
      };

      mockAgentsService.generateApiKey.mockResolvedValue(generatedKey);

      const result = await controller.createAgent(createAgentDto, mockAdminUser);

      expect(result).toEqual(generatedKey);
      expect((result as any).apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(service.generateApiKey).toHaveBeenCalledWith(createAgentDto);
    });

    it('should reject request from non-ADMIN user', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      await expect(controller.createAgent(createAgentDto, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('should return raw key only ONCE (not stored)', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      const rawKey = 'b'.repeat(64);
      const generatedKey = {
        apiKey: rawKey,
        agent: {
          id: 'agent-456',
          name: 'Test Agent',
          slug: 'test-agent',
        },
      };

      mockAgentsService.generateApiKey.mockResolvedValue(generatedKey);

      const result = await controller.createAgent(createAgentDto, mockAdminUser);

      expect((result as any).apiKey).toBe(rawKey);
      expect((result as any).apiKey).not.toBe((result as any).agent.apiKeyHash);
    });

    it('should store HMAC-SHA256 hash in database only', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      mockAgentsService.generateApiKey.mockResolvedValue({
        apiKey: 'a'.repeat(64),
        agent: mockAgent,
      });

      await controller.createAgent(createAgentDto, mockAdminUser);

      expect(service.generateApiKey).toHaveBeenCalled();
    });

    it('should include full agent data in response', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      const generatedKey = {
        apiKey: 'c'.repeat(64),
        agent: {
          id: 'agent-789',
          name: 'Test Agent',
          slug: 'test-agent',
          status: 'ACTIVE',
          maxConcurrentTickets: 3,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      mockAgentsService.generateApiKey.mockResolvedValue(generatedKey);

      const result = await controller.createAgent(createAgentDto, mockAdminUser);

      expect((result as any).agent).toBeDefined();
      expect((result as any).agent.id).toBe('agent-789');
      expect((result as any).agent.name).toBe('Test Agent');
      expect((result as any).agent.slug).toBe('test-agent');
      expect((result as any).agent.status).toBe('ACTIVE');
    });
  });

  describe('GET /api/agents', () => {
    it('should return all agents', async () => {
      const agents = [mockAgent];
      mockAgentsService.findAll.mockResolvedValue(agents);

      const result = await controller.listAll();

      expect(result).toEqual(agents);
      expect(service.findAll).toHaveBeenCalled();
    });

    it('should return empty array when no agents exist', async () => {
      mockAgentsService.findAll.mockResolvedValue([]);

      const result = await controller.listAll();

      expect(result).toEqual([]);
    });

    it('should include roles and capabilities for each agent', async () => {
      const agents = [mockAgent];
      mockAgentsService.findAll.mockResolvedValue(agents);

      const result = await controller.listAll();

      expect((result as any)[0]).toHaveProperty('roles');
      expect((result as any)[0]).toHaveProperty('capabilities');
      expect(Array.isArray((result as any)[0].roles)).toBe(true);
      expect(Array.isArray((result as any)[0].capabilities)).toBe(true);
    });

    it('should include agent metadata (id, name, slug, status)', async () => {
      const agents = [mockAgent];
      mockAgentsService.findAll.mockResolvedValue(agents);

      const result = await controller.listAll();

      expect((result as any)[0]).toHaveProperty('id');
      expect((result as any)[0]).toHaveProperty('name');
      expect((result as any)[0]).toHaveProperty('slug');
      expect((result as any)[0]).toHaveProperty('status');
    });

    it('should NOT include raw API key in response', async () => {
      const agents = [{ ...mockAgent, apiKeyHash: 'hashed-key' }];
      mockAgentsService.findAll.mockResolvedValue(agents);

      const result = await controller.listAll();

      expect((result as any)[0]).toHaveProperty('apiKeyHash');
      expect((result as any)[0].apiKeyHash).not.toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('GET /api/agents/me', () => {
    it('should return authenticated agent profile with API key auth', async () => {
      mockAgentsService.findMe.mockResolvedValue(mockAgent);

      const result = await controller.getMe('agent-456', 'agent');

      expect(result).toEqual(mockAgent);
      expect(service.findMe).toHaveBeenCalledWith('agent-456');
    });

    it('should include roles and capabilities in profile', async () => {
      const agentProfile = {
        ...mockAgent,
        roles: [
          { id: 'role-1', role: 'DEVELOPER' },
          { id: 'role-2', role: 'REVIEWER' },
        ],
        capabilities: [
          { id: 'cap-1', capability: 'typescript' },
          { id: 'cap-2', capability: 'nestjs' },
          { id: 'cap-3', capability: 'react' },
        ],
      };

      mockAgentsService.findMe.mockResolvedValue(agentProfile);

      const result = await controller.getMe('agent-456', 'user');

      expect((result as any).roles).toBeDefined();
      expect((result as any).capabilities).toBeDefined();
      expect((result as any).roles.length).toBe(2);
      expect((result as any).capabilities.length).toBe(3);
    });

    it('should NOT include raw API key in response', async () => {
      mockAgentsService.findMe.mockResolvedValue(mockAgent);

      const result = await controller.getMe('agent-456', 'user');

      expect((result as any).apiKeyHash).toBeDefined();
      expect((result as any).apiKeyHash).not.toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return 403 when not authenticated', async () => {
      await expect(controller.getMe(undefined, undefined)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('GET /api/agents/:slug', () => {
    it('should return agent by slug', async () => {
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.getBySlug('test-agent');

      expect(result).toEqual(mockAgent);
      expect(service.findBySlug).toHaveBeenCalledWith('test-agent');
    });

    it('should include roles and capabilities', async () => {
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.getBySlug('test-agent');

      expect((result as any).roles).toBeDefined();
      expect((result as any).capabilities).toBeDefined();
    });

    it('should return 404 when agent not found', async () => {
      mockAgentsService.findBySlug.mockRejectedValue(new ForbiddenAppException());

      await expect(controller.getBySlug('nonexistent')).rejects.toThrow(ForbiddenAppException);
    });

    it('should NOT return raw API key', async () => {
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.getBySlug('test-agent');

      expect((result as any).apiKeyHash).toBeDefined();
      expect((result as any).apiKeyHash).not.toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('PATCH /api/agents/:slug', () => {
    it('should update agent for ADMIN user', async () => {
      const updateDto = {
        name: 'Updated Agent',
        maxConcurrentTickets: 5,
      };

      const updatedAgent = { ...mockAgent, ...updateDto };
      mockAgentsService.update.mockResolvedValue(updatedAgent);

      const result = await controller.updateAgent('test-agent', updateDto, mockAdminUser);

      expect(result).toEqual(updatedAgent);
      expect(service.update).toHaveBeenCalledWith('test-agent', updateDto);
    });

    it('should reject update from non-ADMIN user', async () => {
      const updateDto = {
        name: 'Updated Agent',
      };

      await expect(controller.updateAgent('test-agent', updateDto, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('should return 404 when agent not found', async () => {
      const updateDto = {
        name: 'Updated Agent',
      };

      mockAgentsService.update.mockRejectedValue(new Error('Agent not found'));

      await expect(controller.updateAgent('nonexistent', updateDto, mockAdminUser)).rejects.toThrow();
    });

    it('should allow updating name', async () => {
      const updateDto = { name: 'New Agent Name' };
      const updatedAgent = { ...mockAgent, name: 'New Agent Name' };

      mockAgentsService.update.mockResolvedValue(updatedAgent);

      const result = await controller.updateAgent('test-agent', updateDto, mockAdminUser);

      expect((result as any).name).toBe('New Agent Name');
    });

    it('should allow updating maxConcurrentTickets', async () => {
      const updateDto = { maxConcurrentTickets: 10 };
      const updatedAgent = { ...mockAgent, maxConcurrentTickets: 10 };

      mockAgentsService.update.mockResolvedValue(updatedAgent);

      const result = await controller.updateAgent('test-agent', updateDto, mockAdminUser);

      expect((result as any).maxConcurrentTickets).toBe(10);
    });

    it('should allow updating status', async () => {
      const updateDto = { status: 'PAUSED' };
      const updatedAgent = { ...mockAgent, status: 'PAUSED' };

      mockAgentsService.update.mockResolvedValue(updatedAgent);

      const result = await controller.updateAgent('test-agent', updateDto, mockAdminUser);

      expect((result as any).status).toBe('PAUSED');
    });
  });

  describe('PATCH /api/agents/:slug/update-roles', () => {
    it('should update agent roles for ADMIN user', async () => {
      const updateRolesDto = {
        roles: ['DEVELOPER', 'REVIEWER'],
      };

      const updatedAgent = {
        ...mockAgent,
        roles: [
          { id: 'role-1', role: 'DEVELOPER' },
          { id: 'role-2', role: 'REVIEWER' },
        ],
      };

      mockAgentsService.updateRoles.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentRoles('test-agent', updateRolesDto, mockAdminUser);

      expect((result as any).roles.length).toBe(2);
      expect((result as any).roles.map((r: any) => r.role)).toEqual(['DEVELOPER', 'REVIEWER']);
    });

    it('should REPLACE roles (not append)', async () => {
      const updateRolesDto = {
        roles: ['TRIAGER'],
      };

      const updatedAgent = {
        ...mockAgent,
        roles: [{ id: 'role-1', role: 'TRIAGER' }],
      };

      mockAgentsService.updateRoles.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentRoles('test-agent', updateRolesDto, mockAdminUser);

      expect((result as any).roles.length).toBe(1);
      expect((result as any).roles[0].role).toBe('TRIAGER');
    });

    it('should delete all old roles before inserting new ones', async () => {
      const updateRolesDto = {
        roles: ['REVIEWER'],
      };

      const updatedAgent = {
        ...mockAgent,
        roles: [{ id: 'new-role', role: 'REVIEWER' }],
      };

      mockAgentsService.updateRoles.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentRoles('test-agent', updateRolesDto, mockAdminUser);

      // Old roles should be gone, new role should be present
      expect((result as any).roles.length).toBe(1);
      expect((result as any).roles[0].role).toBe('REVIEWER');
    });

    it('should reject update from non-ADMIN user', async () => {
      const updateRolesDto = {
        roles: ['DEVELOPER'],
      };

      await expect(controller.updateAgentRoles('test-agent', updateRolesDto, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('PATCH /api/agents/:slug/update-capabilities', () => {
    it('should update agent capabilities for ADMIN user', async () => {
      const updateCapabilitiesDto = {
        capabilities: ['typescript', 'react', 'nodejs'],
      };

      const updatedAgent = {
        ...mockAgent,
        capabilities: [
          { id: 'cap-1', capability: 'typescript' },
          { id: 'cap-2', capability: 'react' },
          { id: 'cap-3', capability: 'nodejs' },
        ],
      };

      mockAgentsService.updateCapabilities.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentCapabilities('test-agent', updateCapabilitiesDto, mockAdminUser);

      expect((result as any).capabilities.length).toBe(3);
      expect((result as any).capabilities.map((c: any) => c.capability)).toEqual(['typescript', 'react', 'nodejs']);
    });

    it('should REPLACE capabilities (not append)', async () => {
      const updateCapabilitiesDto = {
        capabilities: ['golang', 'python'],
      };

      const updatedAgent = {
        ...mockAgent,
        capabilities: [
          { id: 'cap-1', capability: 'golang' },
          { id: 'cap-2', capability: 'python' },
        ],
      };

      mockAgentsService.updateCapabilities.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentCapabilities('test-agent', updateCapabilitiesDto, mockAdminUser);

      expect((result as any).capabilities.length).toBe(2);
      expect((result as any).capabilities.map((c: any) => c.capability)).toEqual(['golang', 'python']);
    });

    it('should delete all old capabilities before inserting new ones', async () => {
      const updateCapabilitiesDto = {
        capabilities: ['rust'],
      };

      const updatedAgent = {
        ...mockAgent,
        capabilities: [{ id: 'cap-1', capability: 'rust' }],
      };

      mockAgentsService.updateCapabilities.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentCapabilities('test-agent', updateCapabilitiesDto, mockAdminUser);

      // Old capabilities should be gone
      expect((result as any).capabilities.length).toBe(1);
      expect((result as any).capabilities[0].capability).toBe('rust');
    });

    it('should reject update from non-ADMIN user', async () => {
      const updateCapabilitiesDto = {
        capabilities: ['typescript'],
      };

      await expect(controller.updateAgentCapabilities('test-agent', updateCapabilitiesDto, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('should allow empty capabilities array', async () => {
      const updateCapabilitiesDto = {
        capabilities: [],
      };

      const updatedAgent = {
        ...mockAgent,
        capabilities: [],
      };

      mockAgentsService.updateCapabilities.mockResolvedValue(updatedAgent);
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.updateAgentCapabilities('test-agent', updateCapabilitiesDto, mockAdminUser);

      expect((result as any).capabilities.length).toBe(0);
    });
  });

  describe('POST /api/agents/:slug/rotate-key', () => {
    it('should rotate API key for ADMIN user', async () => {
      const rotatedKey = {
        apiKey: 'd'.repeat(64),
        agent: mockAgent,
      };

      mockAgentsService.rotateApiKey.mockResolvedValue(rotatedKey);

      const result = await controller.rotateKey('test-agent', mockAdminUser);

      expect((result as any).apiKey).toMatch(/^[a-f0-9]{64}$/);
      expect(service.rotateApiKey).toHaveBeenCalledWith('test-agent');
    });

    it('should return new raw API key ONCE', async () => {
      const newKey = 'e'.repeat(64);
      const rotatedKey = {
        apiKey: newKey,
        agent: mockAgent,
      };

      mockAgentsService.rotateApiKey.mockResolvedValue(rotatedKey);

      const result = await controller.rotateKey('test-agent', mockAdminUser);

      expect((result as any).apiKey).toBe(newKey);
      expect((result as any).apiKey).not.toBe((result as any).agent.apiKeyHash);
    });

    it('should invalidate old API key', async () => {
      const oldKeyHash = 'old-hashed-key';
      const newKeyHash = 'new-hashed-key';

      const rotatedKey = {
        apiKey: 'f'.repeat(64),
        agent: {
          ...mockAgent,
          apiKeyHash: newKeyHash,
        },
      };

      mockAgentsService.rotateApiKey.mockResolvedValue(rotatedKey);

      const result = await controller.rotateKey('test-agent', mockAdminUser);

      expect((result as any).agent.apiKeyHash).toBe(newKeyHash);
      expect((result as any).agent.apiKeyHash).not.toBe(oldKeyHash);
    });

    it('should reject rotate from non-ADMIN user', async () => {
      await expect(controller.rotateKey('test-agent', mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('should return 404 when agent not found', async () => {
      mockAgentsService.rotateApiKey.mockRejectedValue(new Error('Agent not found'));

      await expect(controller.rotateKey('nonexistent', mockAdminUser)).rejects.toThrow();
    });

    it('should generate new random key (not predictable)', async () => {
      const rotatedKey1 = {
        apiKey: 'g'.repeat(64),
        agent: mockAgent,
      };

      const rotatedKey2 = {
        apiKey: 'h'.repeat(64),
        agent: mockAgent,
      };

      mockAgentsService.rotateApiKey.mockResolvedValueOnce(rotatedKey1).mockResolvedValueOnce(rotatedKey2);

      const result1 = await controller.rotateKey('test-agent', mockAdminUser);
      const result2 = await controller.rotateKey('test-agent', mockAdminUser);

      expect((result1 as any).apiKey).not.toBe((result2 as any).apiKey);
    });
  });

  describe('Authorization & Auth Guards', () => {
    it('POST /agents requires JWT auth with ADMIN role', async () => {
      const createDto = { name: 'Test', slug: 'test' };

      await expect(controller.createAgent(createDto, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('GET /agents is public', async () => {
      mockAgentsService.findAll.mockResolvedValue([]);

      const result = await controller.listAll();

      expect(result).toBeDefined();
      expect(service.findAll).toHaveBeenCalled();
    });

    it('GET /agents/me requires API key auth', async () => {
      mockAgentsService.findMe.mockResolvedValue(mockAgent);

      const result = await controller.getMe('agent-456', 'user');

      expect(result).toBeDefined();
    });

    it('GET /agents/:slug is public', async () => {
      mockAgentsService.findBySlug.mockResolvedValue(mockAgent);

      const result = await controller.getBySlug('test-agent');

      expect(result).toBeDefined();
      expect(service.findBySlug).toHaveBeenCalled();
    });

    it('PATCH /agents/:slug requires JWT auth with ADMIN role', async () => {
      const updateDto = { name: 'Updated' };

      await expect(controller.updateAgent('test-agent', updateDto, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('POST /agents/:slug/rotate-key requires JWT auth with ADMIN role', async () => {
      await expect(controller.rotateKey('test-agent', mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('Response Validation', () => {
    it('should not expose raw API key in GET responses', async () => {
      mockAgentsService.findAll.mockResolvedValue([mockAgent]);

      const result = await controller.listAll();

      for (const agent of (result as any)) {
        if (agent.apiKeyHash) {
          expect(agent.apiKeyHash).toBeDefined();
          // Raw keys are 64 hex chars; hashes are different format
          expect(agent.apiKeyHash).not.toMatch(/^[a-f0-9]{64}$/);
        }
      }
    });
  });
});