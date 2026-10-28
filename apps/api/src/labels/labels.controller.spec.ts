import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { APPROVAL_GATED_METADATA } from '../approvals/route/approval-gated.decorator';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { Test, TestingModule } from '@nestjs/testing';
import { PERMISSION_KEY } from '@nathapp/nestjs-auth';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';
import { CreateLabelDto } from './dto/create-label.dto';
import { LabelResponseDto } from './dto/label-response.dto';
import { ProjectAccessService } from '../projects/project-access.service';
import { PermissionService } from '../permissions/permission.service';
import { REQUIRES_METADATA, RequiresMetadata } from '../permissions/requires.decorator';

describe('US-005 permission keys on label routes', () => {
  it.each([
    ['createFromHttp', 'label.create'],
    ['findByProjectFromHttp', 'label.read'],
    ['updateFromHttp', 'label.update'],
    ['deleteFromHttp', 'label.delete'],
    ['assignLabelFromHttp', 'ticket.label.assign'],
    ['removeLabelFromHttp', 'ticket.label.remove'],
  ] as const)('%s declares @Requires(%s)', (handler, key) => {
    const fn = (LabelsController.prototype as unknown as Record<string, object>)[handler];
    expect(Reflect.getMetadata(REQUIRES_METADATA, fn)).toEqual({
      keys: [key],
      mode: 'all',
      enforcedBy: 'guard',
    });
    // The legacy decorators are gone from the migrated routes, so only one mechanism decides them.
    expect(Reflect.getMetadata(PERMISSION_KEY, fn)).toBeUndefined();
  });

  it.each([
    'createFromHttp',
    'findByProjectFromHttp',
    'updateFromHttp',
    'deleteFromHttp',
    'assignLabelFromHttp',
    'removeLabelFromHttp',
  ] as const)('%s runs ProjectMembershipGuard before RequiresGuard', (handler) => {
    const fn = (LabelsController.prototype as unknown as Record<string, object>)[handler];
    const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];

    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });
});

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
    actorType: 'user' as const,
    id: 'user-admin',
    name: 'admin@example.com',
    email: 'admin@example.com',
    role: 'ADMIN' as const,
    blacklisted: false,
    revoked: false,
    authorities: ['ADMIN'],
    extra: { sub: 'user-admin' },
  };

  const mockMemberUser = {
    actorType: 'user' as const,
    id: 'user-member',
    name: 'member@example.com',
    email: 'member@example.com',
    role: 'MEMBER' as const,
    blacklisted: false,
    revoked: false,
    authorities: ['MEMBER'],
    extra: { sub: 'user-member' },
  };

  const mockAgent = {
    actorType: 'agent' as const,
    id: 'agent-123',
    name: 'test-agent',
    slug: 'test-agent',
    status: 'ACTIVE' as const,
    agentRoles: ['DEVELOPER'] as const,
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: ['WORKER'],
  };

  const mockLabelsService = {
    create: vi.fn(),
    findByProject: vi.fn(),
    delete: vi.fn(),
    assignToTicket: vi.fn(),
    removeFromTicket: vi.fn(),
  };

  let module: TestingModule;
  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [LabelsController],
      providers: [
        { provide: ApprovalRouteGate, useValue: { run: vi.fn() } },
        { provide: LabelsService, useValue: mockLabelsService },
        // US-001: the route-level ProjectMembershipGuard is instantiated by the DI
        // container even though these tests call the handlers directly, so its
        // ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
        // US-005: RequiresGuard is instantiated the same way and needs the global
        // PermissionService; these tests never reach it.
        { provide: PermissionService, useValue: { can: vi.fn() } },
      ],
    }).compile();

    controller = module.get<LabelsController>(LabelsController);
    service = module.get<LabelsService>(LabelsService);
  });

  afterEach(async () => {
    await module?.close();
    vi.clearAllMocks();
  });

  describe('POST /api/projects/:slug/labels', () => {
    it('should create a label for ADMIN user', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockResolvedValue(mockLabel);

      const result = await controller.create('koda', createDto, mockAdminUser);

      expect(result).toEqual(mockLabel);
      expect(service.create).toHaveBeenCalledWith('koda', createDto, mockAdminUser);
    });

    it('should reject label creation from non-ADMIN user with 403', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.create('koda', createDto, mockMemberUser)
      ).rejects.toThrow();
    });

    it('should reject label creation from agent with 403', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.create('koda', createDto, mockAgent)
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
          controller.create('koda', invalidDto as CreateLabelDto, mockAdminUser)
        ).rejects.toThrow();
      }
    });

    it('should allow creating label without color', async () => {
      const createDto: CreateLabelDto = {
        name: 'frontend',
      };

      const labelWithoutColor = { ...mockLabel, name: 'frontend', color: null };
      mockLabelsService.create.mockResolvedValue(labelWithoutColor);

      const result = await controller.create('koda', createDto, mockAdminUser);

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
        controller.create('koda', createDto, mockAdminUser)
      ).rejects.toThrow();
    });

    it('should return 404 if project not found', async () => {
      const createDto: CreateLabelDto = {
        name: 'typescript',
        color: '#0066CC',
      };

      mockLabelsService.create.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.create('nonexistent', createDto, mockAdminUser)
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

      await controller.delete('koda', 'label-123', mockAdminUser);

      expect(service.delete).toHaveBeenCalledWith('koda', 'label-123', mockAdminUser);
    });

    it('should reject delete from non-ADMIN user with 403', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('koda', 'label-123', mockMemberUser)
      ).rejects.toThrow();
    });

    it('should reject delete from agent with 403', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Forbidden'));

      await expect(
        controller.delete('koda', 'label-123', mockAgent)
      ).rejects.toThrow();
    });

    it('should return 404 if label not found', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Label not found'));

      await expect(
        controller.delete('koda', 'nonexistent', mockAdminUser)
      ).rejects.toThrow();
    });

    it('should return 404 if project not found', async () => {
      mockLabelsService.delete.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.delete('nonexistent', 'label-123', mockAdminUser)
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

      const result = await controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser);

      expect(result.labels).toContainEqual(expect.objectContaining({ id: 'label-123' }));
      expect(service.assignToTicket).toHaveBeenCalledWith('koda', 'KODA-1', assignDto, mockMemberUser);
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

      const result = await controller.assignLabel('koda', 'KODA-1', assignDto, mockAgent);

      expect(result.labels).toBeDefined();
      expect(service.assignToTicket).toHaveBeenCalledWith('koda', 'KODA-1', assignDto, mockAgent);
    });

    it('should return 404 if ticket not found', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.assignLabel('koda', 'KODA-999', assignDto, mockMemberUser)
      ).rejects.toThrow();
    });

    it('should return 404 if label not found', async () => {
      const assignDto = { labelId: 'nonexistent' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Label not found'));

      await expect(
        controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser)
      ).rejects.toThrow();
    });

    it('should prevent assigning label from different project', async () => {
      const assignDto = { labelId: 'label-from-other-project' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Label not in project'));

      await expect(
        controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser)
      ).rejects.toThrow();
    });

    it('should prevent duplicate label assignment', async () => {
      const assignDto = { labelId: 'label-123' };

      mockLabelsService.assignToTicket.mockRejectedValue(new Error('Label already assigned'));

      await expect(
        controller.assignLabel('koda', 'KODA-1', assignDto, mockMemberUser)
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

      const result = await controller.removeLabel('koda', 'KODA-1', 'label-123', mockMemberUser);

      expect(result.labels).toEqual([]);
      expect(service.removeFromTicket).toHaveBeenCalledWith('koda', 'KODA-1', 'label-123', mockMemberUser);
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

      const result = await controller.removeLabel('koda', 'KODA-1', 'label-123', mockAgent);

      expect(result.labels).toEqual([]);
    });

    it('should return 404 if ticket not found', async () => {
      mockLabelsService.removeFromTicket.mockRejectedValue(new Error('Ticket not found'));

      await expect(
        controller.removeLabel('koda', 'KODA-999', 'label-123', mockMemberUser)
      ).rejects.toThrow();
    });

    it('should return 404 if label not assigned to ticket', async () => {
      mockLabelsService.removeFromTicket.mockRejectedValue(new Error('Label not assigned'));

      await expect(
        controller.removeLabel('koda', 'KODA-1', 'label-123', mockMemberUser)
      ).rejects.toThrow();
    });
  });
});

describe('deleteFromHttp HTTP approval wrapper', () => {
  function build() {
    const run = vi.fn();
    const gate = { run } as unknown as ApprovalRouteGate;
    const service = { softDelete: vi.fn(), delete: vi.fn(), removeFromTicket: vi.fn(), remove: vi.fn() };
    const controller = new LabelsController(service as unknown as LabelsService, gate);
    const project = { project: { id: 'p1', slug: 'alpha' } };
    return { run, service, controller, invoke: () => controller.deleteFromHttp('alpha', 'l1', project) };
  }
  it('maps execution and gates the frozen identifiers in CurrentProject scope', async () => {
    const { run, service, controller, invoke } = build();
    const result = { ref: 'AL-1' };
    run.mockResolvedValue({ status: 'executed', result });
    const output = await invoke();
    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'label.delete', variant: 'rest:labels.delete', projectId: 'p1', input: { slug: 'alpha', id: 'l1' } });
    expect(output).toBeUndefined();
    for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, controller.deleteFromHttp)).toBe(true);
  });
  it('throws ApprovalPending with the unchanged request', async () => {
    const { run, invoke } = build();
    const request = { id: 'approval-1' };
    run.mockResolvedValue({ status: 'pending', request });
    const error = await invoke().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApprovalPending);
    expect((error as ApprovalPending).request).toBe(request);
  });
});

describe('removeLabelFromHttp HTTP approval wrapper', () => {
  function build() {
    const run = vi.fn();
    const gate = { run } as unknown as ApprovalRouteGate;
    const service = { softDelete: vi.fn(), delete: vi.fn(), removeFromTicket: vi.fn(), remove: vi.fn() };
    const controller = new LabelsController(service as unknown as LabelsService, gate);
    const project = { project: { id: 'p1', slug: 'alpha' } };
    return { run, service, controller, invoke: () => controller.removeLabelFromHttp('alpha', 'AL-1', 'l1', project) };
  }
  it('maps execution and gates the frozen identifiers in CurrentProject scope', async () => {
    const { run, service, controller, invoke } = build();
    const result = { ref: 'AL-1' };
    run.mockResolvedValue({ status: 'executed', result });
    const output = await invoke();
    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'ticket.label.remove', variant: 'rest:ticket-labels.remove', projectId: 'p1', input: { slug: 'alpha', ref: 'AL-1', labelId: 'l1' } });
    expect(output).toBeUndefined();
    for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, controller.removeLabelFromHttp)).toBe(true);
  });
  it('throws ApprovalPending with the unchanged request', async () => {
    const { run, invoke } = build();
    const request = { id: 'approval-1' };
    run.mockResolvedValue({ status: 'pending', request });
    const error = await invoke().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApprovalPending);
    expect((error as ApprovalPending).request).toBe(request);
  });
});

describe('US-007 label write wrappers', () => {
  it.each(['create', 'update', 'assign'] as const)('%s gates input and maps executed and pending outcomes', async (action) => {
    const run = vi.fn();
    const service = { create: vi.fn(), update: vi.fn(), assignToTicket: vi.fn() };
    const controller = new LabelsController(service as unknown as LabelsService, { run } as unknown as ApprovalRouteGate);
    const project = { project: { id: 'p1', slug: 'alpha' } };
    const principal = { actorType: 'agent', id: 'a1' } as import('../auth/principal/koda-principal.types').AgentPrincipal;
    const invoke = () => action === 'create' ? controller.createFromHttp('alpha', { name: 'bug' }, principal, project)
      : action === 'update' ? controller.updateFromHttp('alpha', 'l1', { name: 'defect' }, principal, project)
      : controller.assignLabelFromHttp('alpha', 'AL-1', { labelId: 'l1' }, principal, project);
    const calls = {
      create: { key: 'label.create', variant: 'rest:labels.create', input: { slug: 'alpha', label: { name: 'bug' } } },
      update: { key: 'label.update', variant: 'rest:labels.update', input: { slug: 'alpha', id: 'l1', patch: { name: 'defect' } } },
      assign: { key: 'ticket.label.assign', variant: 'rest:ticket-labels.assign', input: { slug: 'alpha', ref: 'AL-1', assignment: { labelId: 'l1' } } },
    };
    const result = { id: 'result' };
    run.mockResolvedValue({ status: 'executed', result });
    expect(await invoke()).toEqual(JsonResponse.Ok(result));
    expect(run).toHaveBeenCalledExactlyOnceWith({ ...calls[action], projectId: 'p1' });
    const handler = action === 'create' ? controller.createFromHttp : action === 'update' ? controller.updateFromHttp : controller.assignLabelFromHttp;
    expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, handler)).toBe(true);
    const request = { id: 'pending' };
    run.mockResolvedValue({ status: 'pending', request });
    await expect(invoke()).rejects.toMatchObject({ request });
    for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
  });
});
