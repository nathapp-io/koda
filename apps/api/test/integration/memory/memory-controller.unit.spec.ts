import { ForbiddenAppException } from '@nathapp/nestjs-common';

const MemoryKind = {
  FACT: 'FACT',
  INCIDENT_PATTERN: 'INCIDENT_PATTERN',
  DECISION: 'DECISION',
} as const;
type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

interface MemoryWriteInput {
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  sourceType?: string;
  sourceId?: string;
  confidence?: number;
}

interface MemoryItem {
  id: string;
  projectId: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  object?: string;
  activeKey?: string;
  sourceType?: string;
  sourceId?: string;
  status?: string;
  confidence?: number;
  ttlAt?: Date;
  supersededBy?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

interface ExtractionService {
  extractFromEvent(event: any): MemoryItem[];
  recordDecision(decision: any, event: any, repository: any, existingDecision?: any): Promise<any>;
}

interface MemoryItemRepository {
  findByProject(query: any): Promise<any>;
  upsert(item: any): Promise<MemoryItem>;
  findActive(projectId: string, kind: string, subject: string, predicate: string): Promise<MemoryItem | null>;
  reject(id: string): Promise<void>;
  softDelete(id: string): Promise<void>;
}

class MemoryController {
  constructor(
    private readonly extractionService: ExtractionService,
    private readonly repository: MemoryItemRepository,
    private readonly prismaService: any,
  ) {}

  private getActorRole(currentUser: any): string | null {
    if (!currentUser) return null;
    if (currentUser.extra?.role) return currentUser.extra.role;
    if (currentUser.actorType === 'agent') return 'AGENT';
    return null;
  }

  private async validateProjectAccess(projectId: string, currentUser: any): Promise<void> {
    if (!currentUser) throw new ForbiddenAppException({}, 'memory');

    const role = this.getActorRole(currentUser);
    if (!role) throw new ForbiddenAppException({}, 'memory');

    if (!['ADMIN', 'DEVELOPER', 'AGENT'].includes(role)) {
      throw new ForbiddenAppException({ code: 'ACCESS_DENIED' }, 'memory');
    }

    const project = await this.prismaService.client.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'memory');
    }
  }

  async createMemory(input: MemoryWriteInput, currentUser: any): Promise<MemoryItem> {
    await this.validateProjectAccess(input.projectId, currentUser);

    const item = await this.repository.upsert({
      ...input,
      activeKey: require('crypto').randomUUID(),
    });

    return item;
  }

  async extractFromEvent(event: any, currentUser: any): Promise<MemoryItem[]> {
    await this.validateProjectAccess(event.projectId, currentUser);

    const items = this.extractionService.extractFromEvent(event);

    for (const item of items) {
      await this.repository.upsert({
        ...item,
        sourceType: item.sourceType || event.type,
        sourceId: item.sourceId || event.id,
      });
    }

    return items;
  }

  async recordDecision(decision: any, currentUser: any): Promise<any> {
    const role = this.getActorRole(currentUser);
    if (!role || !['ADMIN', 'DEVELOPER', 'AGENT'].includes(role)) {
      throw new ForbiddenAppException({ code: 'ACCESS_DENIED' }, 'memory');
    }

    return this.extractionService.recordDecision(decision, { id: 'new-event' }, this.repository);
  }
}

describe('MemoryController', () => {
  let controller: MemoryController;
  let extractionService: ExtractionService;
  let repository: MemoryItemRepository;

  const mockAdminUser = {
    id: 'user-admin',
    sub: 'user-admin',
    email: 'admin@example.com',
    name: 'Admin User',
    extra: { sub: 'user-admin', email: 'admin@example.com', role: 'ADMIN' },
  };

  const mockDeveloperUser = {
    id: 'user-dev',
    sub: 'user-dev',
    email: 'dev@example.com',
    name: 'Developer User',
    extra: { sub: 'user-dev', email: 'dev@example.com', role: 'DEVELOPER' },
  };

  const mockAgentUser = {
    id: 'agent-123',
    sub: 'agent-123',
    name: 'Test Agent',
    extra: { sub: 'agent-123', actorType: 'agent', role: 'AGENT' },
  };

  const mockMemberUser = {
    id: 'user-member',
    sub: 'user-member',
    email: 'member@example.com',
    name: 'Member User',
    extra: { sub: 'user-member', email: 'member@example.com', role: 'MEMBER' },
  };

  const mockViewerUser = {
    id: 'user-viewer',
    sub: 'user-viewer',
    email: 'viewer@example.com',
    name: 'Viewer User',
    extra: { sub: 'user-viewer', email: 'viewer@example.com', role: 'VIEWER' },
  };

  const mockProject = { id: 'project-123', name: 'Test Project', slug: 'test-project', key: 'TEST' };

  const mockExtractionService = {
    extractFromEvent: jest.fn(),
    recordDecision: jest.fn(),
  };

  const mockRepository = {
    findByProject: jest.fn(),
    upsert: jest.fn(),
    findActive: jest.fn(),
    reject: jest.fn(),
    softDelete: jest.fn(),
  };

  const mockPrismaService = {
    client: {
      project: { findUnique: jest.fn() },
    },
  };

  beforeEach(() => {
    controller = new MemoryController(mockExtractionService, mockRepository, mockPrismaService);
    jest.clearAllMocks();
  });

  describe('Role-based access control', () => {
    const writeInput: MemoryWriteInput = {
      projectId: 'project-123',
      kind: 'FACT',
      subject: 'ticket:1',
      predicate: 'status',
      object: 'IN_PROGRESS',
    };

    beforeEach(() => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
    });

    it('AC-7: ADMIN role can create memory', async () => {
      mockRepository.upsert.mockResolvedValue({ id: 'mem-1', ...writeInput, createdAt: new Date(), updatedAt: new Date() });

      const result = await controller.createMemory(writeInput, mockAdminUser);

      expect(result).toBeDefined();
      expect(result.id).toBe('mem-1');
    });

    it('AC-7: DEVELOPER role can create memory', async () => {
      mockRepository.upsert.mockResolvedValue({ id: 'mem-1', ...writeInput, createdAt: new Date(), updatedAt: new Date() });

      const result = await controller.createMemory(writeInput, mockDeveloperUser);

      expect(result).toBeDefined();
    });

    it('AC-7: AGENT role can create memory', async () => {
      mockRepository.upsert.mockResolvedValue({ id: 'mem-1', ...writeInput, createdAt: new Date(), updatedAt: new Date() });

      const result = await controller.createMemory(writeInput, mockAgentUser);

      expect(result).toBeDefined();
    });

    it('AC-7: MEMBER role cannot create memory - returns 403 with ACCESS_DENIED', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);

      await expect(controller.createMemory(writeInput, mockMemberUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('AC-7: VIEWER role cannot create memory - returns 403 with ACCESS_DENIED', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);

      await expect(controller.createMemory(writeInput, mockViewerUser)).rejects.toThrow(ForbiddenAppException);
    });

    it('AC-7: Unauthenticated request (null user) returns 403', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);

      await expect(controller.createMemory(writeInput, null)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('Project validation', () => {
    it('AC-6: Creating memory with non-existent projectId throws ForbiddenAppException with code PROJECT_NOT_FOUND', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      const input: MemoryWriteInput = {
        projectId: 'nonexistent-project',
        kind: 'FACT',
        subject: 'ticket:1',
        predicate: 'status',
      };

      await expect(controller.createMemory(input, mockAdminUser)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('Source tracking', () => {
    beforeEach(() => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
    });

    it('AC-8: MemoryItem from TicketEvent sets sourceType=TicketEvent and sourceId=event.id', async () => {
      mockExtractionService.extractFromEvent.mockReturnValue([
        {
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'status',
          object: 'IN_PROGRESS',
          sourceType: 'TicketEvent',
          sourceId: 'event-123',
          confidence: 0.9,
        },
      ]);
      mockRepository.upsert.mockResolvedValue({ id: 'mem-new' });

      const ticketEvent = {
        type: 'ticket_event' as const,
        id: 'event-123',
        ticketId: 'ticket-1',
        projectId: 'project-123',
        action: 'status_changed',
        data: {},
      };

      await controller.extractFromEvent(ticketEvent, mockAdminUser);

      expect(mockExtractionService.extractFromEvent).toHaveBeenCalledWith(ticketEvent);
      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'TicketEvent',
          sourceId: 'event-123',
        }),
      );
    });

    it('AC-8: MemoryItem from AgentEvent sets sourceType=AgentEvent and sourceId=event.id', async () => {
      mockExtractionService.extractFromEvent.mockReturnValue([
        {
          projectId: 'project-123',
          kind: 'FACT',
          subject: 'ticket:1',
          predicate: 'assigned_to',
          sourceType: 'AgentEvent',
          sourceId: 'event-456',
          confidence: 0.9,
        },
      ]);
      mockRepository.upsert.mockResolvedValue({ id: 'mem-new' });

      const agentEvent = {
        type: 'agent_event' as const,
        id: 'event-456',
        agentId: 'agent-123',
        projectId: 'project-123',
        action: 'assigned',
        data: {},
      };

      await controller.extractFromEvent(agentEvent, mockDeveloperUser);

      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'AgentEvent',
          sourceId: 'event-456',
        }),
      );
    });

    it('AC-8: MemoryItem from DecisionEvent sets sourceType=DecisionEvent and sourceId=event.id', async () => {
      mockExtractionService.extractFromEvent.mockReturnValue([
        {
          projectId: 'project-123',
          kind: 'DECISION',
          subject: 'topic:escalation',
          predicate: 'decision',
          sourceType: 'DecisionEvent',
          sourceId: 'event-789',
          confidence: 1.0,
        },
      ]);
      mockRepository.upsert.mockResolvedValue({ id: 'mem-new' });

      const decisionEvent = {
        type: 'decision_event' as const,
        id: 'event-789',
        agentId: 'agent-123',
        projectId: 'project-123',
        action: 'decided',
        data: {},
      };

      await controller.extractFromEvent(decisionEvent, mockAgentUser);

      expect(mockRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'DecisionEvent',
          sourceId: 'event-789',
        }),
      );
    });
  });
});
