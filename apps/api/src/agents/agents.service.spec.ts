import { AuditRecorder } from '../audit/audit-recorder.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { PermissionService } from '../permissions/permission.service';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { createHmac } from 'crypto';
import { randomBytes } from 'crypto';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AgentPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';
import { AfterCommitService } from '../permissions/after-commit.service';

describe('AgentsService', () => {
  let service: AgentsService;
  let agentRepo: Mocked<PrismaAgentRepository>;
  let kodaDomainWriter: { writeAgentAction: Mock };

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

  // DTO response excludes apiKeyHash for security
  const mockAgentDto = {
    id: 'agent-123',
    name: 'Test Agent',
    slug: 'test-agent',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    capabilities: [
      { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
      { id: 'cap-2', agentId: 'agent-123', capability: 'nestjs' },
    ],
    createdAt: mockAgent.createdAt,
    updatedAt: mockAgent.updatedAt,
  };

  const mockAgentsDto = [mockAgentDto];

  const mockAgentWithRelations = {
    ...mockAgent,
    capabilities: [
      { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
      { id: 'cap-2', agentId: 'agent-123', capability: 'nestjs' },
    ],
  };

  const mockAgentRepo = {
    findAll: vi.fn(),
    findBySlug: vi.fn(),
    findById: vi.fn(),
    findBySlugWithCapabilities: vi.fn(),
    findBySlugScalar: vi.fn(),
    findByIdScalar: vi.fn(),
    create: vi.fn(),
    updateApiKeyHash: vi.fn(),
    update: vi.fn(),
    deleteBySlug: vi.fn(),
    createCapabilities: vi.fn(),
    replaceCapabilities: vi.fn(),
    findProjectBySlug: vi.fn(),
    findVerifiedUnassignedTickets: vi.fn(),
    findByProjectSlug: vi.fn(),
    isOnProjectRoster: vi.fn(),
    findRosterProjects: vi.fn(),
    findProjectRoster: vi.fn(),
  };

  const mockAuthConfig: IAuthConfig = {
    jwtSecret: 'jwt-secret',
    jwtExpiresIn: '15m',
    jwtRefreshSecret: 'jwt-refresh-secret',
    jwtRefreshExpiresIn: '7d',
    apiKeySecret: 'test-secret',
    registrationEnabled: false,
  };

  const mockKodaDomainWriter = {
    writeAgentAction: vi.fn().mockResolvedValue({ canonicalId: 'evt-1' }),
  };

  /** Permissions P1 (US-009): pickup is authorized by the *target* agent's project keys. */
  const mockPermissions = {
    can: vi.fn(async () => ({ allowed: true, reason: 'granted' })),
    effectiveKeys: vi.fn(async () => new Set<string>(['agent.pickup'])),
  };

  /** Permissions P1a (US-004): AgentsService injects the permissions module's MembershipService. */
  const mockMembership = {
    bindOwnerIfFirst: vi.fn(),
    bindBaseline: vi.fn(),
    setGlobalAdmin: vi.fn(),
    removeAllBindings: vi.fn(),
    afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
  };

  // US-003: AgentsService wraps the agent create in txManager.run — the provider
  // must exist or the module cannot be compiled.
  const mockTxManager = {
    run: vi.fn((fn: () => Promise<unknown>) => fn()),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => false),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        AfterCommitService,
        { provide: AuditRecorder, useValue: mockAuditRecorder },
        { provide: PrismaAgentRepository, useValue: mockAgentRepo },
        { provide: AUTH_CFG, useValue: mockAuthConfig },
        { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
        { provide: MembershipService, useValue: mockMembership },
        { provide: PermissionService, useValue: mockPermissions },
        { provide: KodaDomainWriter, useValue: mockKodaDomainWriter },
      ],
    }).compile();

    service = module.get<AgentsService>(AgentsService);
    agentRepo = module.get(PrismaAgentRepository);
    kodaDomainWriter = module.get(KodaDomainWriter);

    mockAgentRepo.createCapabilities.mockResolvedValue(undefined);
    mockMembership.bindBaseline.mockResolvedValue(undefined);
    mockMembership.removeAllBindings.mockResolvedValue(undefined);

    mockAgentRepo.replaceCapabilities.mockResolvedValue(undefined);
    // S4c US-001: GET /agents/me always carries the roster projects, and a
    // rostered target agent is the default for the pickup tests.
    mockAgentRepo.findRosterProjects.mockResolvedValue([]);
    mockAgentRepo.isOnProjectRoster.mockResolvedValue(true);
    // Permissions P1 (US-009): the pickup target holds `agent.pickup` unless a test says otherwise.
    mockPermissions.effectiveKeys.mockResolvedValue(new Set<string>(['agent.pickup']));
    // Permissions P1 (US-002): `can` decides acting for another agent. Reset it at this outer scope too, so a case
    // that installs its own implementation (AC-9 installs a throwing one) cannot leak into a later describe.
    mockPermissions.can.mockReset().mockResolvedValue({ allowed: true, reason: 'granted' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('generateApiKey', () => {
    describe('for new agent creation', () => {
      it('should generate random 32-byte hex key', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

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
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(agentRepo.create).toHaveBeenCalled();
        const createCall = (agentRepo.create as Mock).mock.calls[0][0];

        const expectedHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
        expect(createCall.apiKeyHash).toBe(expectedHash);
      });

      it('should return raw key ONCE to client (not stored)', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(result).toHaveProperty('apiKey');
        expect(result.apiKey).toBeDefined();
        expect(result.apiKey).not.toBe(mockAgent.apiKeyHash);
      });

      it('should store only hash in database', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        const createCall = (agentRepo.create as Mock).mock.calls[0][0];

        // Should NOT store raw key
        expect(createCall.apiKeyHash).not.toBe(result.apiKey);
        expect(createCall.apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
      });

      it('should include agent name and slug in creation', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        expect(agentRepo.create).toHaveBeenCalled();
        const createCall = (agentRepo.create as Mock).mock.calls[0][0];
        expect(createCall.name).toBe('Test Agent');
        expect(createCall.slug).toBe('test-agent');
      });

      it('should use correct API_KEY_SECRET from config', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        const expectedHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');

        const createCall = (agentRepo.create as Mock).mock.calls[0][0];
        expect(createCall.apiKeyHash).toBe(expectedHash);
      });

      it('should throw error when API_KEY_SECRET is not configured', async () => {
        // Mock auth config without apiKeySecret
        const moduleWithoutSecret: TestingModule = await Test.createTestingModule({
          providers: [
            AgentsService,
            AfterCommitService,
            { provide: AuditRecorder, useValue: mockAuditRecorder },
            { provide: PrismaAgentRepository, useValue: mockAgentRepo },
            { provide: AUTH_CFG, useValue: { ...mockAuthConfig, apiKeySecret: undefined } },
            { provide: TRANSACTION_MANAGER, useValue: mockTxManager },
            { provide: MembershipService, useValue: mockMembership },
            { provide: PermissionService, useValue: mockPermissions },
            { provide: KodaDomainWriter, useValue: mockKodaDomainWriter },
          ],
        }).compile();

        const serviceWithoutSecret = moduleWithoutSecret.get<AgentsService>(AgentsService);

        await expect(serviceWithoutSecret.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        })).rejects.toThrow(ValidationAppException);
      });

      it('US-005: never writes an AgentRoleEntry, even when the body carries a legacy roles array', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        const body = { name: 'Test Agent', slug: 'test-agent', capabilities: ['nax'] };
        // A legacy client still sends `roles`; the whitelist pipe drops it before the service sees it.
        Object.assign(body, { roles: ['DEVELOPER'] });

        await service.generateApiKey(body);

        expect(mockAgentRepo.createCapabilities).toHaveBeenCalledWith(mockAgent.id, ['nax']);
        expect(mockAgentRepo).not.toHaveProperty('createRolesAndCapabilities');
      });

      it('should return created agent in response', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);

        const result = await service.generateApiKey({
          name: 'Test Agent',
          slug: 'test-agent',
        });

        // DTO strips apiKeyHash and formats capabilities
        expect(result.agent.id).toBe(mockAgent.id);
        expect(result.agent.name).toBe(mockAgent.name);
        expect(result.agent.slug).toBe(mockAgent.slug);
        expect(result.agent.status).toBe(mockAgent.status);
        expect('apiKeyHash' in result.agent).toBe(false);
      });

      it('binds the new agent to the baseline inside the create transaction (US-004)', async () => {
        mockAgentRepo.create.mockResolvedValue(mockAgent);
        // Track nesting depth so the assertion can tell "inside txManager.run" from "after it".
        let activeRuns = 0;
        let boundInsideRun = false;
        mockTxManager.run.mockImplementation(async (fn: () => Promise<unknown>) => {
          activeRuns += 1;
          try {
            return await fn();
          } finally {
            activeRuns -= 1;
          }
        });
        mockMembership.bindBaseline.mockImplementation(async () => {
          boundInsideRun = activeRuns > 0;
        });

        try {
          await service.generateApiKey({ name: 'Test Agent', slug: 'test-agent' });
        } finally {
          mockTxManager.run.mockImplementation((fn: () => Promise<unknown>) => fn());
        }

        expect(mockMembership.bindBaseline).toHaveBeenCalledTimes(1);
        expect(mockMembership.bindBaseline).toHaveBeenCalledWith({ type: 'AGENT', id: mockAgent.id });
        // The binding is part of the create: it commits with the agent row or not at all.
        expect(boundInsideRun).toBe(true);
        expect(mockTxManager.run).toHaveBeenCalledTimes(1);
      });

      it('does not bind a baseline when the caller only rotates an existing key', async () => {
        mockAgentRepo.updateApiKeyHash.mockResolvedValue(mockAgent);

        await service.generateApiKey(mockAgent.id);

        expect(mockMembership.bindBaseline).not.toHaveBeenCalled();
      });
    });

    describe('for rotating existing agent key', () => {
      it('should generate new random API key', async () => {
        mockAgentRepo.updateApiKeyHash.mockResolvedValue(mockAgent);
        mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgentWithRelations);

        const result = await service.generateApiKey('agent-123');

        expect(result).toHaveProperty('apiKey');
        expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
      });

      it('should replace old API key hash with new one', async () => {
        const oldHash = 'old-hashed-key';
        const agentWithOldHash = { ...mockAgent, apiKeyHash: oldHash };

        mockAgentRepo.updateApiKeyHash.mockResolvedValue(agentWithOldHash);
        mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgentWithRelations);

        const result = await service.generateApiKey('agent-123');

        expect(agentRepo.updateApiKeyHash).toHaveBeenCalled();
        const [, newHash] = (agentRepo.updateApiKeyHash as Mock).mock.calls[0];

        const expectedHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
        expect(newHash).toBe(expectedHash);
        expect(newHash).not.toBe(oldHash);
      });

      it('should invalidate old API key', async () => {
        const oldKey = randomBytes(32).toString('hex');
        const oldHash = createHmac('sha256', 'test-secret').update(oldKey).digest('hex');

        const agentWithOldKey = { ...mockAgent, apiKeyHash: oldHash };
        mockAgentRepo.updateApiKeyHash.mockResolvedValue(agentWithOldKey);
        mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgentWithRelations);

        const result = await service.generateApiKey('agent-123');

        // New hash should not match old key
        const newHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
        expect(newHash).not.toBe(oldHash);
      });

      it('should return new raw key ONCE', async () => {
        mockAgentRepo.updateApiKeyHash.mockResolvedValue(mockAgent);
        mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgentWithRelations);

        const result = await service.generateApiKey('agent-123');

        expect(result.apiKey).toBeDefined();
        expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
      });
    });
  });

  describe('findAll', () => {
    it('should return all agents with their capabilities and no roles', async () => {
      const agents = [mockAgentWithRelations];
      mockAgentRepo.findAll.mockResolvedValue(agents);

      const result = await service.findAll();

      expect(result).toEqual(mockAgentsDto);
      expect(agentRepo.findAll).toHaveBeenCalled();
    });

    it('US-006: reports no roles property for any agent', async () => {
      const agents = [mockAgentWithRelations];
      mockAgentRepo.findAll.mockResolvedValue(agents);

      const result = await service.findAll();

      // New data has no `AgentRoleEntry` row; an agent's roles are role bindings.
      expect(result[0]).not.toHaveProperty('roles');
    });

    it('should include capability entries for each agent', async () => {
      const agents = [mockAgentWithRelations];
      mockAgentRepo.findAll.mockResolvedValue(agents);

      const result = await service.findAll();

      expect(result[0].capabilities).toBeDefined();
      expect(Array.isArray(result[0].capabilities)).toBe(true);
      expect(result[0].capabilities.length).toBe(2);
    });

    it('should return empty array when no agents exist', async () => {
      mockAgentRepo.findAll.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result).toEqual([]);
    });

    it('should fetch agents with their capabilities', async () => {
      const agents = [mockAgentWithRelations];
      mockAgentRepo.findAll.mockResolvedValue(agents);

      await service.findAll();

      expect(agentRepo.findAll).toHaveBeenCalled();
    });
  });

  describe('findBySlug', () => {
    it('should return agent by slug with its capabilities', async () => {
      mockAgentRepo.findBySlug.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findBySlug('test-agent');

      expect(result).toEqual(mockAgentDto);
      expect(agentRepo.findBySlug).toHaveBeenCalledWith('test-agent');
    });

    it('should throw when agent not found', async () => {
      mockAgentRepo.findBySlug.mockResolvedValue(null);

      await expect(service.findBySlug('nonexistent')).rejects.toThrow();
    });

    it('US-006: reports no roles in the response', async () => {
      mockAgentRepo.findBySlug.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findBySlug('test-agent');

      expect(result).not.toHaveProperty('roles');
    });

    it('should include capabilities in response', async () => {
      mockAgentRepo.findBySlug.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findBySlug('test-agent');

      expect(result.capabilities).toBeDefined();
      expect(Array.isArray(result.capabilities)).toBe(true);
    });
  });

  describe('findMe', () => {
    it('should return authenticated agent profile by id with its roster projects', async () => {
      mockAgentRepo.findById.mockResolvedValue(mockAgentWithRelations);
      mockAgentRepo.findRosterProjects.mockResolvedValue([{ slug: 'koda', name: 'Koda' }]);

      const result = await service.findMe('agent-123');

      expect(result).toEqual({
        ...mockAgentDto,
        projects: [{ slug: 'koda', name: 'Koda' }],
      });
      expect(agentRepo.findById).toHaveBeenCalledWith('agent-123');
      expect(agentRepo.findRosterProjects).toHaveBeenCalledWith('agent-123');
    });

    it('should report an empty project list for an agent with no roster rows', async () => {
      mockAgentRepo.findById.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findMe('agent-123');

      expect(result.projects).toEqual([]);
    });

    it('should list each roster project as slug and name, in repository order (S4c US-001 AC15)', async () => {
      mockAgentRepo.findById.mockResolvedValue(mockAgentWithRelations);
      // The repository returns non-deleted roster projects ordered by slug; the
      // DTO must keep that order and must not leak any other column.
      mockAgentRepo.findRosterProjects.mockResolvedValue([
        { slug: 'alpha', name: 'Alpha', deletedAt: null },
        { slug: 'bravo', name: 'Bravo', id: 'project-2' },
      ] as never);

      const result = await service.findMe('agent-123');

      expect(result.projects).toEqual([
        { slug: 'alpha', name: 'Alpha' },
        { slug: 'bravo', name: 'Bravo' },
      ]);
    });

    it('should include capabilities', async () => {
      mockAgentRepo.findById.mockResolvedValue(mockAgentWithRelations);

      const result = await service.findMe('agent-123');

      expect(result.capabilities).toBeDefined();
      expect(result.capabilities.length).toBe(2);
    });

    it('should throw error when agent not found', async () => {
      mockAgentRepo.findById.mockResolvedValue(null);

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
      mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgent);
      mockAgentRepo.update.mockResolvedValue(updatedAgent);

      const result = await service.update('test-agent', updateData);

      expect(result.name).toBe('Updated Agent');
      expect(result.maxConcurrentTickets).toBe(5);
    });

    it('should update agent status', async () => {
      const updateData = { status: 'PAUSED' };
      const updatedAgent = { ...mockAgent, status: 'PAUSED' };
      mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgent);
      mockAgentRepo.update.mockResolvedValue(updatedAgent);

      const result = await service.update('test-agent', updateData);

      expect(result.status).toBe('PAUSED');
    });

    it('should throw error when agent not found', async () => {
      mockAgentRepo.findBySlugScalar.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'New Name' })).rejects.toThrow();
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

      mockAgentRepo.replaceCapabilities.mockResolvedValue(undefined);
      mockAgentRepo.findById.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(agentRepo.replaceCapabilities).toHaveBeenCalledWith('agent-123', ['typescript', 'react', 'nodejs']);
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

      mockAgentRepo.replaceCapabilities.mockResolvedValue(undefined);
      mockAgentRepo.findById.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(agentRepo.replaceCapabilities).toHaveBeenCalledWith('agent-123', ['golang', 'python']);

      expect(result.capabilities.length).toBe(2);
      expect(result.capabilities.map((c: any) => c.capability)).toEqual(['golang', 'python']);
    });

    it('should allow updating to empty capabilities array', async () => {
      const updateData = { capabilities: [] };
      const updatedAgent = {
        ...mockAgentWithRelations,
        capabilities: [],
      };

      mockAgentRepo.replaceCapabilities.mockResolvedValue(undefined);
      mockAgentRepo.findById.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(result.capabilities.length).toBe(0);
    });

    it('should handle duplicate capabilities gracefully', async () => {
      const updateData = { capabilities: ['typescript', 'typescript', 'react'] };
      // Duplicates are de-duped before passing to repo
      const updatedAgent = {
        ...mockAgentWithRelations,
        capabilities: [
          { id: 'cap-1', agentId: 'agent-123', capability: 'typescript' },
          { id: 'cap-2', agentId: 'agent-123', capability: 'react' },
        ],
      };

      mockAgentRepo.replaceCapabilities.mockResolvedValue(undefined);
      mockAgentRepo.findById.mockResolvedValue(updatedAgent);

      const result = await service.updateCapabilities('agent-123', updateData);

      expect(agentRepo.replaceCapabilities).toHaveBeenCalledWith('agent-123', ['typescript', 'react']);
      expect(result.capabilities.length).toBe(2);
    });
  });

  describe('rotateApiKey', () => {
    it('should generate new API key for agent', async () => {
      mockAgentRepo.updateApiKeyHash.mockResolvedValue(mockAgent);
      mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgent);

      const result = await service.rotateApiKey('test-agent');

      expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should invalidate old API key', async () => {
      const oldHash = 'old-hashed-key';
      const agentWithOldHash = { ...mockAgent, apiKeyHash: oldHash };

      mockAgentRepo.updateApiKeyHash.mockResolvedValue(agentWithOldHash);
      mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgent);

      const result = await service.rotateApiKey('test-agent');

      const newHash = createHmac('sha256', 'test-secret').update(result.apiKey).digest('hex');
      expect(newHash).not.toBe(oldHash);
    });

    it('should return raw key ONCE', async () => {
      mockAgentRepo.updateApiKeyHash.mockResolvedValue(mockAgent);
      mockAgentRepo.findBySlugScalar.mockResolvedValue(mockAgent);

      const result = await service.rotateApiKey('test-agent');

      expect(result.apiKey).toBeDefined();
      expect(result.apiKey).not.toBe(mockAgent.apiKeyHash);
    });

    it('should throw error when agent not found', async () => {
      mockAgentRepo.findBySlugScalar.mockResolvedValue(null);

      await expect(service.rotateApiKey('nonexistent')).rejects.toThrow();
    });
  });

  describe('remove', () => {
    it('drops the agent and every binding it held (US-004)', async () => {
      mockAgentRepo.findBySlug.mockResolvedValue(mockAgent);
      mockAgentRepo.deleteBySlug.mockResolvedValue(undefined);

      const removed = await service.remove('test-agent');

      expect(agentRepo.deleteBySlug).toHaveBeenCalledWith('test-agent');
      // `RoleBinding.principalId` has no foreign key, so the rows outlive the agent row.
      expect(mockMembership.removeAllBindings).toHaveBeenCalledWith({ type: 'AGENT', id: mockAgent.id });
      expect(removed.slug).toBe(mockAgent.slug);
    });

    it('404s an unknown slug without touching bindings', async () => {
      mockAgentRepo.findBySlug.mockResolvedValue(null);

      await expect(service.remove('nonexistent')).rejects.toBeInstanceOf(NotFoundAppException);

      expect(agentRepo.deleteBySlug).not.toHaveBeenCalled();
      expect(mockMembership.removeAllBindings).not.toHaveBeenCalled();
    });
  });

  describe('suggestTicket', () => {
    const mockProject = { id: 'project-1', slug: 'koda', key: 'KT' };

    const mockAgentForPickup = {
      id: 'agent-123',
      slug: 'test-agent',
      capabilities: [
        { id: 'cap-1', agentId: 'agent-123', capability: 'nestjs' },
        { id: 'cap-2', agentId: 'agent-123', capability: 'prisma' },
      ],
    };

    // US-003: pickup is restricted to the agent itself (or a global ADMIN user).
    const authorizedPrincipal: AgentPrincipal = {
      actorType: 'agent',
      id: 'agent-123',
      name: 'test-agent',
      slug: 'test-agent',
      status: 'ACTIVE',
      agentRoles: ['DEVELOPER'],
      capabilities: [],
      blacklisted: false,
      revoked: false,
      authorities: ['WORKER'],
    };

    const makeTicket = (id: string, priority: string, labelNames: string[]) => ({
      id,
      priority,
      status: 'VERIFIED',
      assignedToAgentId: null,
      assignedToUserId: null,
      deletedAt: null,
      labels: labelNames.map((name) => ({ label: { name } })),
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mockPermissions.effectiveKeys.mockResolvedValue(new Set<string>(['agent.pickup']));
      // Permissions P1 (US-002): `can` now decides acting for another agent, so a test that overrides it
      // must not leak its answer into the next one.
      mockPermissions.can.mockReset().mockResolvedValue({ allowed: true, reason: 'granted' });
    });

    /** Permissions P1 (US-002): acting for another agent is `agent.update`, not the `role: 'ADMIN'` claim. */
    const userPrincipal = (role: 'ADMIN' | 'MEMBER'): UserPrincipal => ({
      actorType: 'user',
      id: `user-${role.toLowerCase()}`,
      sub: `user-${role.toLowerCase()}`,
      name: `${role.toLowerCase()}@koda.dev`,
      email: `${role.toLowerCase()}@koda.dev`,
      role,
      blacklisted: false,
      revoked: false,
      authorities: [role],
      extra: {},
    });

    it('should return highest-scored ticket with matchScore and matchedCapabilities', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
        makeTicket('ticket-1', 'HIGH', ['nestjs', 'prisma']),
        makeTicket('ticket-2', 'CRITICAL', ['nestjs']),
      ]);

      const result = await service.suggestTicket('test-agent', 'koda', authorizedPrincipal);

      expect(result).not.toBeNull();
      const safeResult = result as NonNullable<typeof result>;
      expect(safeResult.ticket.id).toBe('ticket-1');
      expect(safeResult.matchScore).toBe(2);
      expect(safeResult.matchedCapabilities).toContain('nestjs');
      expect(safeResult.matchedCapabilities).toContain('prisma');
      expect(kodaDomainWriter.writeAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-123', projectId: 'project-1', action: 'TICKET_SUGGESTED' }),
      );
    });

    it('should return null when no VERIFIED unassigned tickets exist in project', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([]);

      const result = await service.suggestTicket('test-agent', 'koda', authorizedPrincipal);

      expect(result).toBeNull();
    });

    it('should throw NotFoundAppException when agent slug is not found', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(null);

      await expect(service.suggestTicket('nonexistent', 'koda', authorizedPrincipal)).rejects.toThrow();
    });

    it('throws ForbiddenAppException (permissions) when the target agent holds no agent.pickup in the project (US-009)', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      // Permissions P1 (US-009): the roster check is gone; the target agent's project keys decide.
      mockPermissions.effectiveKeys.mockResolvedValue(new Set<string>());

      await expect(
        service.suggestTicket('test-agent', 'koda', authorizedPrincipal),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
      // The decision is asked for the *target* agent, in the *project's* scope.
      expect(mockPermissions.effectiveKeys).toHaveBeenCalledWith(
        { type: 'AGENT', id: 'agent-123' },
        { projectId: 'project-1' },
      );
      expect(agentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
      expect(agentRepo.isOnProjectRoster).not.toHaveBeenCalled();
    });

    it('admits the target agent when it holds agent.pickup in the project (US-009)', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([]);

      await expect(service.suggestTicket('test-agent', 'koda', authorizedPrincipal)).resolves.toBeNull();
      expect(mockPermissions.effectiveKeys).toHaveBeenCalledWith(
        { type: 'AGENT', id: 'agent-123' },
        { projectId: 'project-1' },
      );
      // The roster is no longer the roster-read: the permission union reads it.
      expect(agentRepo.isOnProjectRoster).not.toHaveBeenCalled();
    });

    it('should return highest-priority ticket when all scores are 0 (score-0 fallback)', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
        makeTicket('ticket-low', 'LOW', ['unrelated']),
        makeTicket('ticket-critical', 'CRITICAL', ['also-unrelated']),
        makeTicket('ticket-medium', 'MEDIUM', []),
        makeTicket('ticket-high', 'HIGH', ['unknown']),
      ]);

      const result = await service.suggestTicket('test-agent', 'koda', authorizedPrincipal);

      expect(result).not.toBeNull();
      const safeResult = result as NonNullable<typeof result>;
      expect(safeResult.ticket.id).toBe('ticket-critical');
      expect(safeResult.matchScore).toBe(0);
    });

    it('should break ties in score by priority order CRITICAL > HIGH > MEDIUM > LOW', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
        makeTicket('ticket-medium', 'MEDIUM', ['nestjs']),
        makeTicket('ticket-critical', 'CRITICAL', ['nestjs']),
        makeTicket('ticket-low', 'LOW', ['nestjs']),
      ]);

      const result = await service.suggestTicket('test-agent', 'koda', authorizedPrincipal);

      expect(result).not.toBeNull();
      const safeResult = result as NonNullable<typeof result>;
      expect(safeResult.ticket.id).toBe('ticket-critical');
      expect(safeResult.matchScore).toBe(1);
    });

    // -------------------------------------------------------------------------
    // Permissions P1 US-002: acting for another agent is the `agent.update` key. The owning agent is
    // admitted without asking it; every other caller must hold it, whatever its `role` claim says.
    // -------------------------------------------------------------------------

    it('AC-6: a MEMBER user holding agent.update gets a suggestion for another agent', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
        makeTicket('ticket-1', 'HIGH', ['nestjs']),
      ]);
      const memberUser = userPrincipal('MEMBER');

      const result = await service.suggestTicket('test-agent', 'koda', memberUser);

      expect(result).not.toBeNull();
      expect(mockPermissions.can).toHaveBeenCalledWith(memberUser, 'agent.update');
      // The target's keys are still the second gate.
      expect(mockPermissions.effectiveKeys).toHaveBeenCalledWith(
        { type: 'AGENT', id: 'agent-123' },
        { projectId: 'project-1' },
      );
    });

    it('AC-7: an ADMIN user whose agent.update is refused gets 403 agents before any target-agent key read', async () => {
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });
      const adminUser = userPrincipal('ADMIN');

      const error = await service
        .suggestTicket('test-agent', 'koda', adminUser)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).prefix).toBe('agents');
      expect(mockPermissions.effectiveKeys).not.toHaveBeenCalled();
      expect(mockAgentRepo.findBySlugWithCapabilities).not.toHaveBeenCalled();
      expect(mockAgentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
    });

    it('AC-8: another agent without agent.update gets 403 agents before any target-agent key read', async () => {
      mockPermissions.can.mockResolvedValue({ allowed: false, reason: 'not-granted' });
      const otherAgent: AgentPrincipal = { ...authorizedPrincipal, id: 'agent-999', slug: 'other' };

      const error = await service
        .suggestTicket('test-agent', 'koda', otherAgent)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ForbiddenAppException);
      expect((error as ForbiddenAppException).prefix).toBe('agents');
      expect(mockPermissions.can).toHaveBeenCalledWith(otherAgent, 'agent.update');
      expect(mockPermissions.effectiveKeys).not.toHaveBeenCalled();
      expect(mockAgentRepo.findVerifiedUnassignedTickets).not.toHaveBeenCalled();
    });

    it('AC-9: the owning agent gets a suggestion without asking can at all', async () => {
      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([
        makeTicket('ticket-1', 'HIGH', ['nestjs']),
      ]);
      mockPermissions.can.mockImplementation(() => {
        throw new Error('can must not be asked for the owning agent');
      });

      const result = await service.suggestTicket('test-agent', 'koda', authorizedPrincipal);

      expect(result).not.toBeNull();
      expect(mockPermissions.can).not.toHaveBeenCalled();
      // The target's own `agent.pickup` is still checked.
      expect(mockPermissions.effectiveKeys).toHaveBeenCalledWith(
        { type: 'AGENT', id: 'agent-123' },
        { projectId: 'project-1' },
      );
    });

    it('should only consider tickets where both assignedToAgentId and assignedToUserId are null', async () => {
      const unassignedTicket = makeTicket('unassigned-ticket', 'LOW', ['nestjs']);

      mockAgentRepo.findBySlugWithCapabilities.mockResolvedValue(mockAgentForPickup);
      mockAgentRepo.findProjectBySlug.mockResolvedValue(mockProject);
      // The service should query via repo with the right filters
      mockAgentRepo.findVerifiedUnassignedTickets.mockResolvedValue([unassignedTicket]);

      const result = await service.suggestTicket('test-agent', 'koda', authorizedPrincipal);

      expect(result).not.toBeNull();
      const safeResult = result as NonNullable<typeof result>;
      expect(safeResult.ticket.id).toBe('unassigned-ticket');
      // Verify the repo was called with the project id
      expect(agentRepo.findVerifiedUnassignedTickets).toHaveBeenCalledWith('project-1');
    });
  });

  describe('findByProject', () => {
    it('returns agents derived from project tickets', async () => {
      const mockRepoResult = {
        project: { id: 'proj-1', slug: 'alpha' },
        agents: [
          {
            id: 'agent-1',
            name: 'Bot',
            slug: 'bot',
            status: 'ACTIVE',
            maxConcurrentTickets: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
            capabilities: [{ id: 'c1', agentId: 'agent-1', capability: 'typescript' }],
          },
        ],
      };
      mockAgentRepo.findByProjectSlug.mockResolvedValue(mockRepoResult);

      const result = await service.findByProject('alpha');

      expect(mockAgentRepo.findByProjectSlug).toHaveBeenCalledWith('alpha');
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('bot');
    });

    it('throws NotFoundAppException when project does not exist', async () => {
      mockAgentRepo.findByProjectSlug.mockResolvedValue(null);

      await expect(service.findByProject('nonexistent')).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('listProjectRoster', () => {
    const makeRecord = (over: {
      slug?: string;
      addedById?: string | null;
      addedByName?: string | null;
      openTicketCount?: number;
      openTicketRefs?: string[];
    } = {}) => ({
      slug: over.slug ?? 'bot',
      name: 'Bot',
      status: 'ACTIVE',
      capabilities: ['typescript'],
      openTicketCount: over.openTicketCount ?? 0,
      openTicketRefs: over.openTicketRefs ?? [],
      addedAt: new Date('2026-10-01T00:00:00.000Z'),
      addedById: over.addedById === undefined ? 'user-admin' : over.addedById,
      addedByName: over.addedByName === undefined ? 'Admin' : over.addedByName,
    });

    it('US-006: answers the roster as { items } alone, with no roles on a row', async () => {
      mockAgentRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: null });
      mockAgentRepo.findProjectRoster.mockResolvedValue([makeRecord()]);

      const result = await service.listProjectRoster('alpha');

      expect(mockAgentRepo.findProjectBySlug).toHaveBeenCalledWith('alpha');
      expect(mockAgentRepo.findProjectRoster).toHaveBeenCalledWith('proj-1');
      // `scoping` was always true; the roster answer is the items alone.
      expect(Object.keys(result)).toEqual(['items']);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        slug: 'bot',
        status: 'ACTIVE',
        capabilities: ['typescript'],
        openTicketCount: 0,
        openTicketRefs: [],
        addedBy: { id: 'user-admin', name: 'Admin' },
      });
      expect(result.items[0]).not.toHaveProperty('roles');
      expect(result.items[0].addedAt).toEqual(expect.any(String));
    });

    it('returns null addedBy for backfilled roster rows', async () => {
      mockAgentRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: null });
      mockAgentRepo.findProjectRoster.mockResolvedValue([makeRecord({ addedById: null, addedByName: null })]);

      const result = await service.listProjectRoster('alpha');

      expect(result.items[0].addedBy).toBeNull();
    });

    it('carries the open-ticket summary from the repository', async () => {
      mockAgentRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: null });
      mockAgentRepo.findProjectRoster.mockResolvedValue([
        makeRecord({ openTicketCount: 3, openTicketRefs: ['ALP-1', 'ALP-2', 'ALP-3'] }),
      ]);

      const result = await service.listProjectRoster('alpha');

      expect(result.items[0].openTicketCount).toBe(3);
      expect(result.items[0].openTicketRefs).toEqual(['ALP-1', 'ALP-2', 'ALP-3']);
    });

    it('throws NotFoundAppException when the project is missing or soft-deleted', async () => {
      mockAgentRepo.findProjectBySlug.mockResolvedValue({ id: 'proj-1', slug: 'alpha', deletedAt: new Date() });

      await expect(service.listProjectRoster('alpha')).rejects.toThrow(NotFoundAppException);
      expect(mockAgentRepo.findProjectRoster).not.toHaveBeenCalled();
    });
  });

  describe('API Key Validation', () => {
    it('should generate unique API keys on multiple calls', async () => {
      mockAgentRepo.create.mockResolvedValue(mockAgent);

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
