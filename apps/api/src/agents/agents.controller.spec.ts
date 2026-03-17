import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ForbiddenException as _ForbiddenException } from '@nestjs/common';

describe('AgentsController', () => {
  let controller: AgentsController;
  let service: AgentsService;

  const mockAgentsService = {
    generateApiKey: jest.fn(),
  };

  const mockUser = {
    sub: 'user-123',
    email: 'admin@example.com',
    role: 'ADMIN',
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
    it('should generate API key for authenticated ADMIN user', async () => {
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
        },
      };

      mockAgentsService.generateApiKey.mockResolvedValue(generatedKey);

      const req: any = { user: mockUser };

      const result = await controller.generateApiKey(createAgentDto, req);

      expect(result).toEqual(generatedKey);
      expect(service.generateApiKey).toHaveBeenCalled();
    });

    it('should reject request from non-ADMIN user', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      const memberUser = {
        sub: 'user-456',
        email: 'member@example.com',
        role: 'MEMBER',
      };

      const req: any = { user: memberUser };

      await expect(controller.generateApiKey(createAgentDto, req)).rejects.toThrow();
    });

    it('should return generated API key ONCE', async () => {
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
        },
      };

      mockAgentsService.generateApiKey.mockResolvedValue(generatedKey);

      const req: any = { user: mockUser };

      const result = await controller.generateApiKey(createAgentDto, req);

      expect(result.apiKey).toBe(generatedKey.apiKey);
      expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include agent data in response', async () => {
      const createAgentDto = {
        name: 'Test Agent',
        slug: 'test-agent',
      };

      const generatedKey = {
        apiKey: 'b'.repeat(64),
        agent: {
          id: 'agent-456',
          name: 'Test Agent',
          slug: 'test-agent',
          status: 'ACTIVE',
        },
      };

      mockAgentsService.generateApiKey.mockResolvedValue(generatedKey);

      const req: any = { user: mockUser };

      const result = await controller.generateApiKey(createAgentDto, req);

      expect(result.agent).toBeDefined();
      expect(result.agent.id).toBe('agent-456');
      expect(result.agent.name).toBe('Test Agent');
    });
  });
});
