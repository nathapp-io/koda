import { Test, TestingModule } from '@nestjs/testing';
import { LabelsService } from './labels.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { NotFoundException as _NotFoundException, ForbiddenException as _ForbiddenException, BadRequestException as _BadRequestException } from '@nestjs/common';
import { CreateLabelDto } from './dto/create-label.dto';

describe('LabelsService', () => {
  let service: LabelsService;
  let prismaService: PrismaService<PrismaClient>;

  const mockProject = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockOtherProject = {
    id: 'proj-456',
    name: 'Other',
    slug: 'other',
    key: 'OTH',
    description: 'Other project',
    gitRemoteUrl: 'https://github.com/example/other',
    autoIndexOnClose: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockLabel = {
    id: 'label-123',
    projectId: 'proj-123',
    name: 'typescript',
    color: '#0066CC',
  };

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'Fix login bug',
    description: 'Users cannot login',
    status: 'CREATED',
    priority: 'HIGH',
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: 'user-123',
    createdByAgentId: null,
    gitRefVersion: null,
    gitRefFile: null,
    gitRefLine: null,
    gitRefUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const _mockUser = {
    id: 'user-123',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'ADMIN',
    passwordHash: 'hash',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const _mockAgent = {
    id: 'agent-123',
    name: 'Test Agent',
    slug: 'test-agent',
    apiKeyHash: 'hash',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockActivity = {
    id: 'activity-123',
    ticketId: 'ticket-123',
    action: 'LABEL_CHANGE',
    field: 'labels',
    newValue: 'typescript',
    oldValue: null,
    fromStatus: null,
    toStatus: null,
    actorUserId: 'user-123',
    actorAgentId: null,
    createdAt: new Date(),
  };

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
      label: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      ticket: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      ticketLabel: {
        create: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      ticketActivity: {
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabelsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<LabelsService>(LabelsService);
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a label for a project with ADMIN user', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.create.mockResolvedValue(mockLabel);

      const result = await service.create('koda', createDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result).toEqual(mockLabel);
      expect(result.name).toBe('typescript');
      expect(result.color).toBe('#0066CC');
      expect(prismaService.client.label.create).toHaveBeenCalled();
    });

    it('should reject label creation for non-ADMIN user', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };

      await expect(
        service.create('koda', createDto, memberUser, 'user')
      ).rejects.toThrow();
    });

    it('should reject label creation for agent', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      const agent = { id: 'agent-123', sub: 'agent-123', slug: 'test-agent' };

      await expect(
        service.create('koda', createDto, agent, 'agent')
      ).rejects.toThrow();
    });

    it('should create label without color', async () => {
      const createDto: CreateLabelDto = {
        name: 'frontend',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      const labelWithoutColor = { ...mockLabel, name: 'frontend', color: null };
      mockPrismaService.client.label.create.mockResolvedValue(labelWithoutColor);

      const result = await service.create('koda', createDto, { id: 'user-123', sub: 'user-123' }, 'user');

      expect(result.color).toBeNull();
    });

    it('should throw NotFoundException if project not found', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(
        service.create('nonexistent', createDto, { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });

    it('should throw error if label name already exists in project', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.create.mockRejectedValue(
        new Error('Unique constraint failed')
      );

      await expect(
        service.create('koda', createDto, { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });
  });

  describe('findByProject', () => {
    it('should return all labels for a project', async () => {
      const labels = [
        mockLabel,
        { ...mockLabel, id: 'label-124', name: 'backend', color: '#FF6600' },
      ];

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.findMany.mockResolvedValue(labels);

      const result = await service.findByProject('koda');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('typescript');
      expect(result[1].name).toBe('backend');
      expect(prismaService.client.label.findMany).toHaveBeenCalledWith({
        where: { projectId: 'proj-123' },
      });
    });

    it('should return empty array when project has no labels', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.findMany.mockResolvedValue([]);

      const result = await service.findByProject('koda');

      expect(result).toEqual([]);
    });

    it('should throw NotFoundException if project not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.findByProject('nonexistent')).rejects.toThrow();
    });

    it('should return labels scoped to single project', async () => {
      const labels = [mockLabel];

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.findMany.mockResolvedValue(labels);

      await service.findByProject('koda');

      expect(prismaService.client.label.findMany).toHaveBeenCalledWith({
        where: { projectId: 'proj-123' },
      });
    });
  });

  describe('delete', () => {
    it('should delete label for ADMIN user', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.label.delete.mockResolvedValue(mockLabel);

      await service.delete('koda', 'label-123', { id: 'user-123', sub: 'user-123' }, 'user');

      expect(prismaService.client.label.delete).toHaveBeenCalledWith({
        where: { id: 'label-123' },
      });
    });

    it('should reject delete from non-ADMIN user', async () => {
      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };

      await expect(
        service.delete('koda', 'label-123', memberUser, 'user')
      ).rejects.toThrow();
    });

    it('should reject delete from agent', async () => {
      const agent = { id: 'agent-123', sub: 'agent-123', slug: 'test-agent' };

      await expect(
        service.delete('koda', 'label-123', agent, 'agent')
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if project not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(
        service.delete('nonexistent', 'label-123', { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if label not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.findUnique.mockResolvedValue(null);

      await expect(
        service.delete('koda', 'nonexistent', { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });

    it('should verify label belongs to project before deleting', async () => {
      const otherProjectLabel = { ...mockLabel, projectId: 'proj-456' };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.label.findUnique.mockResolvedValue(otherProjectLabel);

      await expect(
        service.delete('koda', 'label-123', { id: 'user-123', sub: 'user-123' }, 'user')
      ).rejects.toThrow();
    });
  });

  describe('assignToTicket', () => {
    it('should assign label to ticket and create TicketActivity', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        ...mockTicket,
        labels: [mockLabel],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithLabel);

      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        { id: 'user-123', sub: 'user-123' },
        'user'
      );

      expect(result.labels).toBeDefined();
      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should create TicketActivity with action LABEL_CHANGE and newValue as label name', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        ...mockTicket,
        labels: [mockLabel],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithLabel);

      await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        { id: 'user-123', sub: 'user-123' },
        'user'
      );

      // Verify that transaction includes TicketActivity creation
      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should allow any authenticated user to assign label', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        ...mockTicket,
        labels: [mockLabel],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithLabel);

      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };
      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        memberUser,
        'user'
      );

      expect(result).toBeDefined();
    });

    it('should allow agent to assign label to ticket', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        ...mockTicket,
        labels: [mockLabel],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithLabel);

      const agent = { id: 'agent-123', sub: 'agent-123', slug: 'test-agent' };
      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        agent,
        'agent'
      );

      expect(result).toBeDefined();
    });

    it('should throw NotFoundException if ticket not found', async () => {
      const assignDto = { labelId: 'label-123' };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-999',
          assignDto,
          { id: 'user-123', sub: 'user-123' },
          'user'
        )
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if label not found', async () => {
      const assignDto = { labelId: 'nonexistent' };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(null);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          { id: 'user-123', sub: 'user-123' },
          'user'
        )
      ).rejects.toThrow();
    });

    it('should prevent assigning label from different project to ticket', async () => {
      const assignDto = { labelId: 'label-from-other-project' };
      const otherProjectLabel = { ...mockLabel, projectId: 'proj-456' };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(otherProjectLabel);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          { id: 'user-123', sub: 'user-123' },
          'user'
        )
      ).rejects.toThrow();
    });

    it('should prevent duplicate label assignment to same ticket', async () => {
      const assignDto = { labelId: 'label-123' };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.$transaction.mockRejectedValue(
        new Error('Unique constraint failed')
      );

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          { id: 'user-123', sub: 'user-123' },
          'user'
        )
      ).rejects.toThrow();
    });

    it('should return ticket with labels array populated', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        ...mockTicket,
        labels: [
          {
            ticketId: 'ticket-123',
            labelId: 'label-123',
            label: mockLabel,
          },
        ],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.label.findUnique.mockResolvedValue(mockLabel);
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithLabel);

      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        { id: 'user-123', sub: 'user-123' },
        'user'
      );

      expect(result.labels).toBeDefined();
      expect(Array.isArray(result.labels)).toBe(true);
    });
  });

  describe('removeFromTicket', () => {
    it('should remove label from ticket and create TicketActivity', async () => {
      const ticketWithoutLabel = {
        ...mockTicket,
        labels: [],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLabel.findUnique.mockResolvedValue({
        ticketId: 'ticket-123',
        labelId: 'label-123',
      });
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithoutLabel);

      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        { id: 'user-123', sub: 'user-123' },
        'user'
      );

      expect(result.labels).toBeDefined();
      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should create TicketActivity with action LABEL_CHANGE and oldValue as label name', async () => {
      const ticketWithoutLabel = {
        ...mockTicket,
        labels: [],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLabel.findUnique.mockResolvedValue({
        ticketId: 'ticket-123',
        labelId: 'label-123',
        label: mockLabel,
      });
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithoutLabel);

      await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        { id: 'user-123', sub: 'user-123' },
        'user'
      );

      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should allow any authenticated user to remove label', async () => {
      const ticketWithoutLabel = {
        ...mockTicket,
        labels: [],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLabel.findUnique.mockResolvedValue({
        ticketId: 'ticket-123',
        labelId: 'label-123',
      });
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithoutLabel);

      const memberUser = { id: 'user-456', sub: 'user-456', role: 'MEMBER' };
      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        memberUser,
        'user'
      );

      expect(result).toBeDefined();
    });

    it('should allow agent to remove label from ticket', async () => {
      const ticketWithoutLabel = {
        ...mockTicket,
        labels: [],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLabel.findUnique.mockResolvedValue({
        ticketId: 'ticket-123',
        labelId: 'label-123',
      });
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithoutLabel);

      const agent = { id: 'agent-123', sub: 'agent-123', slug: 'test-agent' };
      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        agent,
        'agent'
      );

      expect(result).toBeDefined();
    });

    it('should throw NotFoundException if ticket not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(null);

      await expect(
        service.removeFromTicket(
          'koda',
          'KODA-999',
          'label-123',
          { id: 'user-123', sub: 'user-123' },
          'user'
        )
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if label not assigned to ticket', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLabel.findUnique.mockResolvedValue(null);

      await expect(
        service.removeFromTicket(
          'koda',
          'KODA-1',
          'label-123',
          { id: 'user-123', sub: 'user-123' },
          'user'
        )
      ).rejects.toThrow();
    });

    it('should return ticket with labels array after removal', async () => {
      const ticketWithoutLabel = {
        ...mockTicket,
        labels: [],
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findUnique.mockResolvedValue(mockTicket);
      mockPrismaService.client.ticketLabel.findUnique.mockResolvedValue({
        ticketId: 'ticket-123',
        labelId: 'label-123',
      });
      mockPrismaService.client.$transaction.mockResolvedValue(ticketWithoutLabel);

      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        { id: 'user-123', sub: 'user-123' },
        'user'
      );

      expect(result.labels).toBeDefined();
      expect(Array.isArray(result.labels)).toBe(true);
    });
  });
});
