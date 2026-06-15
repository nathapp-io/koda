import { Test, TestingModule } from '@nestjs/testing';
import { LabelsService } from './labels.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { LABEL_REPOSITORY } from './domain/label.domain';
import type { KodaAgentRole } from '../auth/principal/koda-principal.types';

describe('LabelsService', () => {
  let service: LabelsService;

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
    deletedAt: null,
    labels: [{ label: mockLabel }],
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

  const mockUserPrincipal = {
    id: 'user-123',
    sub: 'user-123',
    actorType: 'user' as const,
    role: 'ADMIN' as const,
    email: 'admin@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Admin User',
  };

  const mockMemberPrincipal = {
    id: 'user-456',
    sub: 'user-456',
    actorType: 'user' as const,
    role: 'MEMBER' as const,
    email: 'user456@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test User',
  };

  const mockAgentPrincipal = {
    id: 'agent-123',
    sub: 'agent-123',
    actorType: 'agent' as const,
    slug: 'test-agent',
    status: 'ACTIVE' as const,
    agentRoles: [] as KodaAgentRole[],
    capabilities: [] as string[],
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Test Agent',
  };

  const mockLabelRepo = {
    findProjectBySlug: jest.fn(),
    createLabel: jest.fn(),
    findLabelsByProject: jest.fn(),
    findLabelById: jest.fn(),
    deleteLabel: jest.fn(),
    updateLabel: jest.fn(),
    findTicketByRef: jest.fn(),
    findTicketLabelAssignment: jest.fn(),
    findTicketLabelWithLabel: jest.fn(),
    assignLabelToTicket: jest.fn(),
    removeLabelFromTicket: jest.fn(),
    createTicketActivity: jest.fn(),
    findTicketWithLabels: jest.fn(),
    runInTransaction: jest.fn((fn: () => unknown) => fn()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabelsService,
        { provide: LABEL_REPOSITORY, useValue: mockLabelRepo },
      ],
    }).compile();

    service = module.get<LabelsService>(LabelsService);
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

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.createLabel.mockResolvedValue(mockLabel);

      const result = await service.create('koda', createDto, mockUserPrincipal);

      expect(result).toEqual(mockLabel);
      expect(result.name).toBe('typescript');
      expect(result.color).toBe('#0066CC');
      expect(mockLabelRepo.createLabel).toHaveBeenCalled();
    });

    it('should allow label creation for non-ADMIN user (authorization at controller level)', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.createLabel.mockResolvedValue({ ...mockLabel, name: 'typescript', color: '#0066CC' });

      const result = await service.create('koda', createDto, mockMemberPrincipal);
      expect(result.name).toBe('typescript');
    });

    it('should allow label creation for agent', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.createLabel.mockResolvedValue({ ...mockLabel, name: 'typescript', color: '#0066CC' });

      await expect(
        service.create('koda', createDto, mockAgentPrincipal)
      ).resolves.toMatchObject({ name: 'typescript', color: '#0066CC' });
    });

    it('should create label without color', async () => {
      const createDto: CreateLabelDto = {
        name: 'frontend',
      };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      const labelWithoutColor = { ...mockLabel, name: 'frontend', color: null };
      mockLabelRepo.createLabel.mockResolvedValue(labelWithoutColor);

      const result = await service.create('koda', createDto, mockUserPrincipal);

      expect(result.color).toBeNull();
    });

    it('should throw NotFoundException if project not found', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.create('nonexistent', createDto, mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should throw error if label name already exists in project', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.createLabel.mockRejectedValue(
        new Error('Unique constraint failed')
      );

      await expect(
        service.create('koda', createDto, mockUserPrincipal)
      ).rejects.toThrow();
    });
  });

  describe('findByProject', () => {
    it('should return all labels for a project', async () => {
      const labels = [
        mockLabel,
        { ...mockLabel, id: 'label-124', name: 'backend', color: '#FF6600' },
      ];

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelsByProject.mockResolvedValue(labels);

      const result = await service.findByProject('koda');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('typescript');
      expect(result[1].name).toBe('backend');
      expect(mockLabelRepo.findLabelsByProject).toHaveBeenCalledWith('proj-123');
    });

    it('should return empty array when project has no labels', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelsByProject.mockResolvedValue([]);

      const result = await service.findByProject('koda');

      expect(result).toEqual([]);
    });

    it('should throw NotFoundException if project not found', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.findByProject('nonexistent')).rejects.toThrow();
    });

    it('should return labels scoped to single project', async () => {
      const labels = [mockLabel];

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelsByProject.mockResolvedValue(labels);

      await service.findByProject('koda');

      expect(mockLabelRepo.findLabelsByProject).toHaveBeenCalledWith('proj-123');
    });
  });

  describe('delete', () => {
    it('should delete label for ADMIN user', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.deleteLabel.mockResolvedValue(undefined);

      await service.delete('koda', 'label-123', mockUserPrincipal);

      expect(mockLabelRepo.deleteLabel).toHaveBeenCalledWith('label-123');
    });

    it('should allow delete from non-ADMIN user (authorization at controller level)', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.deleteLabel.mockResolvedValue(undefined);

      await expect(
        service.delete('koda', 'label-123', mockMemberPrincipal)
      ).resolves.toBeUndefined();
    });

    it('should allow delete from agent', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.deleteLabel.mockResolvedValue(undefined);

      await expect(
        service.delete('koda', 'label-123', mockAgentPrincipal)
      ).resolves.toBeUndefined();
    });

    it('should throw NotFoundException if project not found', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(
        service.delete('nonexistent', 'label-123', mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if label not found', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelById.mockResolvedValue(null);

      await expect(
        service.delete('koda', 'nonexistent', mockUserPrincipal)
      ).rejects.toThrow();
    });

    it('should verify label belongs to project before deleting', async () => {
      const otherProjectLabel = { ...mockLabel, projectId: 'proj-456' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findLabelById.mockResolvedValue(otherProjectLabel);

      await expect(
        service.delete('koda', 'label-123', mockUserPrincipal)
      ).rejects.toThrow();
    });
  });

  describe('assignToTicket', () => {
    const ticketWithFlatLabels = {
      id: 'ticket-123',
      projectId: 'proj-123',
      number: 1,
      deletedAt: null,
      labels: [mockLabel],
    };

    it('should assign label to ticket and create TicketActivity', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.findTicketLabelAssignment.mockResolvedValue(null);
      mockLabelRepo.assignLabelToTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithFlatLabels);

      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        mockUserPrincipal
      );

      expect(result.labels).toBeDefined();
      expect(mockLabelRepo.runInTransaction).toHaveBeenCalled();
    });

    it('should create TicketActivity with action LABEL_CHANGE and newValue as label name', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.findTicketLabelAssignment.mockResolvedValue(null);
      mockLabelRepo.assignLabelToTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithFlatLabels);

      await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        mockUserPrincipal
      );

      expect(mockLabelRepo.runInTransaction).toHaveBeenCalled();
      expect(mockLabelRepo.createTicketActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LABEL_CHANGE', newValue: 'typescript' })
      );
    });

    it('should allow any authenticated user to assign label', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.findTicketLabelAssignment.mockResolvedValue(null);
      mockLabelRepo.assignLabelToTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithFlatLabels);

      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        mockMemberPrincipal
      );

      expect(result).toBeDefined();
    });

    it('should allow agent to assign label to ticket', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.findTicketLabelAssignment.mockResolvedValue(null);
      mockLabelRepo.assignLabelToTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithFlatLabels);

      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        mockAgentPrincipal
      );

      expect(result).toBeDefined();
    });

    it('should throw NotFoundException if ticket not found', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(null);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          mockUserPrincipal
        )
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if label not found', async () => {
      const assignDto = { labelId: 'nonexistent' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(null);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          mockUserPrincipal
        )
      ).rejects.toThrow();
    });

    it('should prevent assigning label from different project to ticket', async () => {
      const assignDto = { labelId: 'label-from-other-project' };
      const otherProjectLabel = { ...mockLabel, projectId: 'proj-456' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(otherProjectLabel);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          mockUserPrincipal
        )
      ).rejects.toThrow();
    });

    it('should prevent duplicate label assignment to same ticket', async () => {
      const assignDto = { labelId: 'label-123' };
      const existingAssignment = { ticketId: 'ticket-123', labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.findTicketLabelAssignment.mockResolvedValue(existingAssignment);

      await expect(
        service.assignToTicket(
          'koda',
          'KODA-1',
          assignDto,
          mockUserPrincipal
        )
      ).rejects.toThrow();
    });

    it('should return ticket with labels array populated', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findLabelById.mockResolvedValue(mockLabel);
      mockLabelRepo.findTicketLabelAssignment.mockResolvedValue(null);
      mockLabelRepo.assignLabelToTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithFlatLabels);

      const result = await service.assignToTicket(
        'koda',
        'KODA-1',
        assignDto,
        mockUserPrincipal
      );

      expect(result.labels).toBeDefined();
      expect(Array.isArray(result.labels)).toBe(true);
    });
  });

  describe('removeFromTicket', () => {
    const ticketWithoutLabel = {
      id: 'ticket-123',
      projectId: 'proj-123',
      number: 1,
      deletedAt: null,
      labels: [],
    };

    const ticketLabelWithLabel = {
      ticketId: 'ticket-123',
      labelId: 'label-123',
      label: mockLabel,
    };

    it('should remove label from ticket and create TicketActivity', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findTicketLabelWithLabel.mockResolvedValue(ticketLabelWithLabel);
      mockLabelRepo.removeLabelFromTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithoutLabel);

      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        mockUserPrincipal
      );

      expect(result.labels).toBeDefined();
      expect(mockLabelRepo.runInTransaction).toHaveBeenCalled();
    });

    it('should create TicketActivity with action LABEL_CHANGE and oldValue as label name', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findTicketLabelWithLabel.mockResolvedValue(ticketLabelWithLabel);
      mockLabelRepo.removeLabelFromTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithoutLabel);

      await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        mockUserPrincipal
      );

      expect(mockLabelRepo.runInTransaction).toHaveBeenCalled();
      expect(mockLabelRepo.createTicketActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LABEL_CHANGE', oldValue: 'typescript' })
      );
    });

    it('should allow any authenticated user to remove label', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findTicketLabelWithLabel.mockResolvedValue(ticketLabelWithLabel);
      mockLabelRepo.removeLabelFromTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithoutLabel);

      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        mockUserPrincipal
      );

      expect(result).toBeDefined();
    });

    it('should allow agent to remove label from ticket', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findTicketLabelWithLabel.mockResolvedValue(ticketLabelWithLabel);
      mockLabelRepo.removeLabelFromTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithoutLabel);

      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        mockAgentPrincipal
      );

      expect(result).toBeDefined();
    });

    it('should throw NotFoundException if ticket not found', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(null);

      await expect(
        service.removeFromTicket(
          'koda',
          'KODA-999',
          'label-123',
          mockUserPrincipal
        )
      ).rejects.toThrow();
    });

    it('should throw NotFoundException if label not assigned to ticket', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findTicketLabelWithLabel.mockResolvedValue(null);

      await expect(
        service.removeFromTicket(
          'koda',
          'KODA-1',
          'label-123',
          mockUserPrincipal
        )
      ).rejects.toThrow();
    });

    it('should return ticket with labels array after removal', async () => {
      mockLabelRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockLabelRepo.findTicketByRef.mockResolvedValue(mockTicket);
      mockLabelRepo.findTicketLabelWithLabel.mockResolvedValue(ticketLabelWithLabel);
      mockLabelRepo.removeLabelFromTicket.mockResolvedValue(undefined);
      mockLabelRepo.createTicketActivity.mockResolvedValue(mockActivity);
      mockLabelRepo.findTicketWithLabels.mockResolvedValue(ticketWithoutLabel);

      const result = await service.removeFromTicket(
        'koda',
        'KODA-1',
        'label-123',
        mockUserPrincipal
      );

      expect(result.labels).toBeDefined();
      expect(Array.isArray(result.labels)).toBe(true);
    });
  });
});
