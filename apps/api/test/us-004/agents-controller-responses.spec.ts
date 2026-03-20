/**
 * US-004 — AgentsController response envelope
 *
 * Every controller method must return a JsonResponse instance.
 * These tests are RED until AgentsController is updated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from '../../src/agents/agents.controller';
import { AgentsService } from '../../src/agents/agents.service';
import { JsonResponse } from '../../src/common/json-response';

describe('AgentsController — JsonResponse envelope (US-004)', () => {
  let controller: AgentsController;

  const mockAgent = {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    status: 'ACTIVE',
    roles: [],
    capabilities: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAgentWithKey = { ...mockAgent, apiKey: 'raw-key-abc' };

  const mockAgentsService = {
    generateApiKey: jest.fn().mockResolvedValue(mockAgentWithKey),
    findAll: jest.fn().mockResolvedValue([mockAgent]),
    findMe: jest.fn().mockResolvedValue(mockAgent),
    findBySlug: jest.fn().mockResolvedValue(mockAgent),
    update: jest.fn().mockResolvedValue(mockAgent),
    updateRoles: jest.fn().mockResolvedValue(mockAgent),
    updateCapabilities: jest.fn().mockResolvedValue(mockAgent),
    rotateApiKey: jest.fn().mockResolvedValue(mockAgentWithKey),
  };

  const adminReq: any = { user: { sub: 'user-1', role: 'ADMIN' } };
  const agentReq: any = {
    user: { sub: 'agent-1', actorType: 'agent' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [{ provide: AgentsService, useValue: mockAgentsService }],
    }).compile();

    controller = module.get<AgentsController>(AgentsController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /agents', () => {
    it('returns a JsonResponse instance', async () => {
      const dto = { name: 'Bot', slug: 'bot' };
      const result = await controller.generateApiKey(dto as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps agent data with apiKey under result.data', async () => {
      const dto = { name: 'Bot', slug: 'bot' };
      const result = await controller.generateApiKey(dto as any, adminReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('apiKey');
    });
  });

  describe('GET /agents', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findAll();
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps agents array under result.data', async () => {
      const result = await controller.findAll();
      const envelope = result as unknown as JsonResponse;
      expect(Array.isArray(envelope.data)).toBe(true);
    });
  });

  describe('GET /agents/me', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findMe(agentReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps agent profile under result.data', async () => {
      const result = await controller.findMe(agentReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('id');
    });
  });

  describe('GET /agents/:slug', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.findBySlug('test-agent');
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps agent under result.data', async () => {
      const result = await controller.findBySlug('test-agent');
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('slug', 'test-agent');
    });
  });

  describe('PATCH /agents/:slug', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.update('test-agent', { name: 'Updated' } as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('PATCH /agents/:slug/update-roles', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.updateRoles('test-agent', { roles: [] } as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('PATCH /agents/:slug/update-capabilities', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.updateCapabilities('test-agent', { capabilities: [] } as any, adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });
  });

  describe('POST /agents/:slug/rotate-key', () => {
    it('returns a JsonResponse instance', async () => {
      const result = await controller.rotateApiKey('test-agent', adminReq);
      expect(result).toBeInstanceOf(JsonResponse);
    });

    it('wraps rotated key data under result.data', async () => {
      const result = await controller.rotateApiKey('test-agent', adminReq);
      const envelope = result as unknown as JsonResponse;
      expect(envelope.data).toHaveProperty('apiKey');
    });
  });
});
