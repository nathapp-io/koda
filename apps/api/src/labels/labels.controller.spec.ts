import { Test, TestingModule } from '@nestjs/testing';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { NotFoundException as _NotFoundException, ForbiddenException as _ForbiddenException, BadRequestException as _BadRequestException } from '@nestjs/common';
import { CreateLabelDto } from './dto/create-label.dto';
import { LabelResponseDto } from './dto/label-response.dto';

describe('LabelsController', () => {
  let controller: LabelsController;
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

  const mockLabel: LabelResponseDto = {
    id: 'label-123',
    projectId: 'proj-123',
    name: 'typescript',
    color: '#0066CC',
  };

  const mockAdminUser = {
    sub: 'user-admin',
    email: 'admin@example.com',
    role: 'ADMIN',
  };

  const mockMemberUser = {
    sub: 'user-member',
    email: 'member@example.com',
    role: 'MEMBER',
  };

  const mockAgent = {
    sub: 'agent-123',
    slug: 'test-agent',
  };

  const mockLabelsService = {
    create: jest.fn(),
    findByProject: jest.fn(),
    delete: jest.fn(),
    assignToTicket: jest.fn(),
    removeFromTicket: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LabelsController],
      providers: [{ provide: LabelsService, useValue: mockLabelsService }],
    }).compile();

    controller = module.get<LabelsController>(LabelsController);
    service = module.get<LabelsService>(LabelsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/projects/:slug/labels', () => {
    it('should create a label for ADMIN user', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockResolvedValue(mockLabel);

      const result = await controller.create('koda', createDto, mockAdminUser, 'user');

      expect(result).toEqual(mockLabel);
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAdminUser, 'user');
    });

    it('should reject label creation from non-ADMIN user with 403', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.create('koda', createDto, mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should reject label creation from agent with 403', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.create('koda', createDto, mockAgent, 'agent')
      ).rejects.toThrow();
    });

    it('should validate required field name', async () => {
      const invalidDtos = [
        { color: '#0066CC' }, // Missing name
        { name: '', color: '#0066CC' }, // Empty name
      ];

      mockLabelsService.create.mockRejectedValue(new Error('Validation error'));

      for (const invalidDto of invalidDtos) {
        await expect(
          controller.create('koda', invalidDto as CreateLabelDto, mockAdminUser, 'user')
        ).rejects.toThrow();
      }
    });

    it('should allow creating label without color', async () => {
      const createDto: CreateLabelDto = {
        name: 'frontend',
      };

      const labelWithoutColor = { ...mockLabel, name: 'frontend', color: null };
      mockLabelsService.create.mockResolvedValue(labelWithoutColor);

      const result = await controller.create('koda', createDto, mockAdminUser, 'user');

      expect(result.name).toBe('frontend');
      expect(result.color).toBeNull();
    });

    it('should prevent duplicate label names in same project', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Label already exists'));

      await expect(
        controller.create('koda', createDto, mockAdminUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 404 if project not found', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.create('nonexistent', createDto, mockAdminUser, 'user')
      ).rejects.toThrow();
    });
  });

  describe('GET /api/projects/:slug/labels', () => {
    it('should list all labels for a project', async () => {
      const labels = [
        mockLabel,
        { ...mockLabel, id: 'label-124', name: 'backend', color: '#FF6600' },
      ];

      mockLabelsService.findByProject.mockResolvedValue(labels);

      const result = await controller.findByProject('koda');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockLabel);
      expect(result[1].name).toBe('backend');
      expect(service.findByProject).toHaveBeenCalledWith('koda');
    });

    it('should return empty array when project has no labels', async () => {
      mockLabelsService.findByProject.mockResolvedValue([]);

      const result = await controller.findByProject('koda');

      expect(result).toEqual([]);
    });

    it('should include all label fields (id, name, color, projectId)', async () => {
      const fullLabel: LabelResponseDto = {
        id: 'label-123',
        projectId: 'proj-123',
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.findByProject.mockResolvedValue([fullLabel]);

      const result = await controller.findByProject('koda');

      expect(result[0].id).toBeDefined();
      expect(result[0].projectId).toBeDefined();
      expect(result[0].name).toBeDefined();
      expect(result[0].color).toBeDefined();
    });

    it('should return 404 if project not found', async () => {
      mockLabelsService.findByProject.mockRejectedValue(new Error('Project not found'));

      await expect(controller.findByProject('nonexistent')).rejects.toThrow();
    });

    it('should allow any authenticated user to list labels', async () => {
      mockLabelsService.findByProject.mockResolvedValue([mockLabel]);

      const result = await controller.findByProject('koda');

      expect(result).toBeDefined();
    });
  });

  describe('DELETE /api/projects/:slug/labels/:id', () => {
    it('should delete label for ADMIN user', async () => {
      mockLabelsService.delete.mockResolvedValue(undefined);

      await controller.delete('koda', 'label-123', mockAdminUser, 'user');

      expect(service.delete).toHaveBeenCalledWith('koda', 'label-123', mockAdminUser, 'user');
    });

    it('should reject delete from non-ADMIN user with 403', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('koda', 'label-123', mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should reject delete from agent with 403', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('koda', 'label-123', mockAgent, 'agent')
      ).rejects.toThrow();
    });

    it('should return 404 if label not found', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Label not found'));

      await expect(
        controller.delete('koda', 'nonexistent', mockAdminUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 404 if project not found', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.delete('nonexistent', 'label-123', mockAdminUser, 'user')
      ).rejects.toThrow();
    });
  });

  describe('POST /api/projects/:slug/tickets/:ref/labels', () => {
    it('should assign label to ticket for authenticated user', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        id: 'ticket-123',
        projectId: 'proj-123',
        number: 1,
        type: 'BUG',
        title: 'Fix bug',
        status: 'CREATED',
        priority: 'HIGH',
        labels: [mockLabel],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      mockLabelsService.assignToTicket.mockResolvedValue(ticketWithLabel);

      const result = await controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser, 'user');

      expect(result.labels).toContainEqual(expect.objectContaining({ id: 'label-123' }));
      expect(service.assignToTicket).toHaveBeenCalledWith('koda', 'KODA-1', assignDto, mockMemberUser, 'user');
    });

    it('should assign label to ticket for authenticated agent', async () => {
      const assignDto = { labelId: 'label-123' };
      const ticketWithLabel = {
        id: 'ticket-123',
        projectId: 'proj-123',
        number: 1,
        type: 'BUG',
        title: 'Fix bug',
        status: 'CREATED',
        priority: 'HIGH',
        labels: [mockLabel],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      mockLabelsService.assignToTicket.mockResolvedValue(ticketWithLabel);

      const result = await controller.assignLabel('koda', 'KODA-1', assignDto, mockAgent, 'agent');

      expect(result.labels).toBeDefined();
      expect(service.assignToTicket).toHaveBeenCalledWith('koda', 'KODA-1', assignDto, mockAgent, 'agent');
    });

    it('should return 404 if ticket not found', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.assignLabel('koda', 'KODA-999', assignDto, mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 404 if label not found', async () => {
      const assignDto = { labelId: 'nonexistent' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Label not found'));

      await expect(
        controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should prevent assigning label from different project', async () => {
      const assignDto = { labelId: 'label-from-other-project' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Label not in project'));

      await expect(
        controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should prevent duplicate label assignment', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Label already assigned'));

      await expect(
        controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser, 'user')
      ).rejects.toThrow();
    });
  });

  describe('DELETE /api/projects/:slug/tickets/:ref/labels/:labelId', () => {
    it('should remove label from ticket for authenticated user', async () => {
      const ticketWithoutLabel = {
        id: 'ticket-123',
        projectId: 'proj-123',
        number: 1,
        type: 'BUG',
        title: 'Fix bug',
        status: 'CREATED',
        priority: 'HIGH',
        labels: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      mockLabelsService.removeFromTicket.mockResolvedValue(ticketWithoutLabel);

      const result = await controller.removeLabel('koda', 'KODA-1', 'label-123', mockMemberUser, 'user');

      expect(result.labels).toEqual([]);
      expect(service.removeFromTicket).toHaveBeenCalledWith('koda', 'KODA-1', 'label-123', mockMemberUser, 'user');
    });

    it('should remove label from ticket for authenticated agent', async () => {
      const ticketWithoutLabel = {
        id: 'ticket-123',
        projectId: 'proj-123',
        number: 1,
        type: 'BUG',
        title: 'Fix bug',
        status: 'CREATED',
        priority: 'HIGH',
        labels: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      mockLabelsService.removeFromTicket.mockResolvedValue(ticketWithoutLabel);

      const result = await controller.removeLabel('koda', 'KODA-1', 'label-123', mockAgent, 'agent');

      expect(result.labels).toEqual([]);
    });

    it('should return 404 if ticket not found', async () => {
      mockLabelsService.removeFromTicket.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.removeLabel('koda', 'KODA-999', 'label-123', mockMemberUser, 'user')
      ).rejects.toThrow();
    });

    it('should return 404 if label not assigned to ticket', async () => {
      mockLabelsService.removeFromTicket.mockRejectedValue(new Error('Label not assigned'));

      await expect(
        controller.removeLabel('koda', 'KODA-1', 'label-123', mockMemberUser, 'user')
      ).rejects.toThrow();
    });
  });
});
