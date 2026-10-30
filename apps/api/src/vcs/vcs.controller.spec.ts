import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ValidationAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { VCS_CFG } from '../config/vcs.config';
import { PermissionService } from '../permissions/permission.service';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { VcsController } from './vcs.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectAccessService } from '../projects/project-access.service';
import type { ProjectContext } from '../projects/project-context';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import type { VcsConnectionDomain } from './domain/vcs.domain';

vi.mock('./factory', () => ({
  createVcsProvider: vi.fn(),
}));

vi.mock('../common/utils/encryption.util', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-token'),
  encryptToken: vi.fn().mockReturnValue('enc-token'),
}));


function makeProjectDto(overrides?: object) {
  return {
    id: 'proj-1',
    name: 'Test Project',
    slug: 'test-project',
    key: 'TEST',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
    deletedAt: null,
    ciWebhookToken: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeConnectionResponse(overrides?: Partial<VcsConnectionResponseDto>): VcsConnectionResponseDto {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    syncMode: 'off',
    allowedAuthors: [],
    pollingIntervalMs: 600000,
    webhookSecretConfigured: false,
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFullConnection(overrides?: Partial<VcsConnectionDomain>): VcsConnectionDomain {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'off',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('VcsController', () => {
  let controller: VcsController;
  let mockProjectsService: Mocked<Pick<ProjectsService, 'findBySlug'>>;
  let mockVcsService: Mocked<Pick<VcsConnectionService, 'create' | 'findByProject' | 'update' | 'delete' | 'testConnection' | 'getFullByProject' | 'rotateWebhookSecret'>>;
  let mockSyncService: Mocked<Pick<VcsSyncService, 'syncIssue' | 'fullSync'>>;
  let mockPrSyncService: Mocked<Pick<VcsPrSyncService, 'syncPrStatus'>>;
  let mockVcsConfig: { encryptionKey: string | null };

  let module: TestingModule;
  let gate: { run: ReturnType<typeof vi.fn> };
  const encryptionKey = 'test-key-32-chars-exactly-padded!!';

  const projectContext = (): ProjectContext => ({ project: { id: 'proj-1', slug: 'test-project' } });

  beforeEach(async () => {
    mockProjectsService = {
      findBySlug: vi.fn().mockResolvedValue(makeProjectDto()),
    };

    mockVcsService = {
      create: vi.fn().mockResolvedValue(makeConnectionResponse()),
      findByProject: vi.fn().mockResolvedValue(makeConnectionResponse()),
      update: vi.fn().mockResolvedValue(makeConnectionResponse()),
      delete: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 }),
      getFullByProject: vi.fn().mockResolvedValue(makeFullConnection()),
      rotateWebhookSecret: vi.fn().mockResolvedValue({ webhookSecret: 'a'.repeat(32) }),
    };

    mockSyncService = {
      syncIssue: vi.fn().mockResolvedValue({ action: 'created', ticketId: 't-1', ticketNumber: 5, ticketTitle: 'Issue title' }),
      fullSync: vi.fn().mockResolvedValue({ issuesSynced: 2, issuesSkipped: 1, createdTickets: [{ id: 't-1', number: 5, title: 'Issue title' }], errors: [] }),
    };

    mockPrSyncService = {
      syncPrStatus: vi.fn().mockResolvedValue({ updated: 3, skipped: 0 }),
    };

    mockVcsConfig = {
      encryptionKey,
    };

    gate = {
      run: vi.fn(async (call: {
        variant?: string;
        input: { projectId: string; connection: CreateVcsConnectionDto; patch: UpdateVcsConnectionDto };
      }) => {
        if (call.variant === 'rest:vcs.create') {
          return { status: 'executed', result: await mockVcsService.create(call.input.projectId, encryptionKey, call.input.connection) };
        }
        if (call.variant === 'rest:vcs.update') {
          return { status: 'executed', result: await mockVcsService.update(call.input.projectId, encryptionKey, call.input.patch) };
        }
        if (call.variant === 'rest:vcs.rotate-webhook-secret') {
          return { status: 'executed', result: await mockVcsService.rotateWebhookSecret(call.input.projectId) };
        }
        return { status: 'executed', result: { ok: true, latencyMs: 100 } };
      }),
    };
    module = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        { provide: ApprovalRouteGate, useValue: gate },
        { provide: PermissionService, useValue: { can: vi.fn().mockResolvedValue({ allowed: true }) } },
        { provide: VcsConnectionService, useValue: mockVcsService },
        { provide: VcsSyncService, useValue: mockSyncService },
        { provide: VcsPrSyncService, useValue: mockPrSyncService },
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: ProjectAccessService, useValue: {} },
        { provide: VCS_CFG, useValue: mockVcsConfig },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
  });

  afterEach(async () => {
    await module?.close();
    vi.clearAllMocks();
  });

  describe('createConnection', () => {
    it('should resolve the project by slug and delegate to vcsService.create', async () => {
      const dto: CreateVcsConnectionDto = {
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        token: 'ghp_abc',
      } as CreateVcsConnectionDto;

      const result = await controller.createConnection('test-project', dto);

      expect(mockProjectsService.findBySlug).toHaveBeenCalledWith('test-project');
      expect(mockVcsService.create).toHaveBeenCalledWith('proj-1', encryptionKey, dto);
      expect(result.data).toMatchObject({ id: 'conn-1' });
    });


    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(
        controller.createConnection('test-project', {} as CreateVcsConnectionDto),
      ).rejects.toThrow(ValidationAppException);
      expect(gate.run).not.toHaveBeenCalled();
    });

    it('AC-11: gates create with the resolved project, the parsed body and the redeem header', async () => {
      const dto: CreateVcsConnectionDto = {
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        token: 'ghp_abc',
      } as CreateVcsConnectionDto;

      await controller.createConnection('s', dto, 'r1');

      expect(gate.run).toHaveBeenCalledExactlyOnceWith({
        key: 'vcs.connection.create',
        variant: 'rest:vcs.create',
        projectId: 'proj-1',
        input: { slug: 's', projectId: 'proj-1', connection: dto },
        redeem: 'r1',
      });
    });

    it('AC-11: a pending create request answers with the approval summary', async () => {
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });

      await expect(
        controller.createConnection('test-project', {} as CreateVcsConnectionDto),
      ).rejects.toThrow(ApprovalPending);
      expect(mockVcsService.create).not.toHaveBeenCalled();
    });
  });

  describe('getConnection', () => {
    it('should resolve the project by slug and return the connection', async () => {
      const result = await controller.getConnection('test-project');

      expect(mockProjectsService.findBySlug).toHaveBeenCalledWith('test-project');
      expect(mockVcsService.findByProject).toHaveBeenCalledWith('proj-1');
      expect(result.data).toMatchObject({ id: 'conn-1' });
    });

  });

  describe('updateConnection', () => {
    it('should resolve the project by slug and delegate to vcsService.update', async () => {
      const dto: UpdateVcsConnectionDto = { syncMode: 'polling' } as UpdateVcsConnectionDto;

      await controller.updateConnection('test-project', dto);
      expect(mockVcsService.update).toHaveBeenCalledWith('proj-1', encryptionKey, dto);
    });


    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(
        controller.updateConnection('test-project', {} as UpdateVcsConnectionDto),
      ).rejects.toThrow(ValidationAppException);
    });

    it('AC-13: gates the update with the connection read before the gate and the redeem header', async () => {
      const dto: UpdateVcsConnectionDto = { syncMode: 'polling' } as UpdateVcsConnectionDto;

      await controller.updateConnection('s', dto, 'r1');

      expect(gate.run).toHaveBeenCalledExactlyOnceWith({
        key: 'vcs.connection.update',
        variant: 'rest:vcs.update',
        projectId: 'proj-1',
        input: { slug: 's', projectId: 'proj-1', connectionId: 'conn-1', patch: dto },
        redeem: 'r1',
      });
      const gateCall = gate.run.mock.calls[0][0] as { input: { connectionId: string } };
      expect(gateCall.input.connectionId).toBe('conn-1');
      expect(mockVcsService.findByProject.mock.invocationCallOrder[0])
        .toBeLessThan(gate.run.mock.invocationCallOrder[0]);
    });

    it('AC-13: a missing connection rejects with vcs 404 before the gate', async () => {
      mockVcsService.findByProject.mockRejectedValue(new NotFoundAppException({}, 'vcs'));

      await expect(
        controller.updateConnection('s', {} as UpdateVcsConnectionDto, 'r1'),
      ).rejects.toMatchObject({ prefix: 'vcs' });
      expect(gate.run).not.toHaveBeenCalled();
    });

    it('AC-13: an empty encryption key rejects 400 vcs before the connection is read', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(
        controller.updateConnection('s', {} as UpdateVcsConnectionDto, 'r1'),
      ).rejects.toThrow(ValidationAppException);
      expect(mockVcsService.findByProject).not.toHaveBeenCalled();
      expect(gate.run).not.toHaveBeenCalled();
    });

    it('AC-2: a pending update request answers with the approval summary and writes nothing', async () => {
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });

      await expect(
        controller.updateConnection('s', { syncMode: 'polling' } as UpdateVcsConnectionDto),
      ).rejects.toThrow(ApprovalPending);
      expect(mockVcsService.update).not.toHaveBeenCalled();
    });
  });

  describe('gated routes', () => {
    it('uses resolved project context for delete and returns no body', async () => {
      expect(await controller.deleteConnection('unused-slug', projectContext())).toBeUndefined();
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'vcs.connection.delete', variant: 'rest:vcs.delete', projectId: 'proj-1', input: { projectId: 'proj-1' } });
      expect(mockProjectsService.findBySlug).not.toHaveBeenCalled();
      expect(mockVcsService.delete).not.toHaveBeenCalled();
    });
    it('returns the gated test result unchanged', async () => {
      const result = await controller.testConnection('unused-slug', projectContext());
      expect(result.data).toEqual({ ok: true, latencyMs: 100 });
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'vcs.connection.test', variant: 'rest:vcs.test', projectId: 'proj-1', input: { projectId: 'proj-1' } });
      expect(mockProjectsService.findBySlug).not.toHaveBeenCalled();
      expect(mockVcsService.testConnection).not.toHaveBeenCalled();
    });
    it('AC-8: missing encryption key throws vcs validation before the gate', async () => {
      mockVcsConfig.encryptionKey = null;
      await expect(controller.testConnection('unused-slug', projectContext())).rejects.toMatchObject({ prefix: 'vcs' });
      await expect(controller.testConnection('unused-slug', projectContext())).rejects.toThrow(ValidationAppException);
      expect(gate.run).not.toHaveBeenCalled();
    });
    it.each(['deleteConnection', 'testConnection'] as const)('throws ApprovalPending for %s', async (method) => {
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });
      await expect(controller[method]('unused-slug', projectContext())).rejects.toThrow(ApprovalPending);
    });
  });

  describe('rotateWebhookSecret', () => {
    it('wraps the rotated secret in JsonResponse.Ok for a user', async () => {
      mockVcsService.rotateWebhookSecret.mockResolvedValue({ webhookSecret: 'b'.repeat(32) });

      const result = await controller.rotateWebhookSecret(projectContext());

      expect(result.ret).toBe(0);
      expect(result.data).toEqual({ webhookSecret: 'b'.repeat(32) });
      expect(mockVcsService.rotateWebhookSecret).toHaveBeenCalledWith('proj-1');
    });

    it('delegates secret rotation for an agent with project context', async () => {
      mockVcsService.rotateWebhookSecret.mockResolvedValue({ webhookSecret: 'c'.repeat(32) });

      const result = await controller.rotateWebhookSecret(projectContext());

      expect(result.data).toEqual({ webhookSecret: 'c'.repeat(32) });
      expect(mockVcsService.rotateWebhookSecret).toHaveBeenCalledWith('proj-1');
    });

    it('US-003 AC-7: gates the rotation with the connection read before the gate and the redeem header', async () => {
      await controller.rotateWebhookSecret(projectContext(), 'r1');

      expect(gate.run).toHaveBeenCalledExactlyOnceWith({
        key: 'vcs.webhook-secret.rotate',
        variant: 'rest:vcs.rotate-webhook-secret',
        projectId: 'proj-1',
        input: { slug: 'test-project', projectId: 'proj-1', connectionId: 'conn-1' },
        redeem: 'r1',
      });
      expect(mockVcsService.findByProject.mock.invocationCallOrder[0])
        .toBeLessThan(gate.run.mock.invocationCallOrder[0]);
    });

    it('US-003: a missing connection rejects with vcs 404 before the gate', async () => {
      mockVcsService.findByProject.mockRejectedValue(new NotFoundAppException({}, 'vcs'));

      await expect(controller.rotateWebhookSecret(projectContext(), 'r1')).rejects.toMatchObject({ prefix: 'vcs' });
      expect(gate.run).not.toHaveBeenCalled();
    });

    it('US-003: a pending rotation answers with the approval summary and rotates nothing', async () => {
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });

      await expect(controller.rotateWebhookSecret(projectContext())).rejects.toThrow(ApprovalPending);
      expect(mockVcsService.rotateWebhookSecret).not.toHaveBeenCalled();
    });
  });

  describe('manual issue sync gates', () => {
    it.each(['syncIssue', 'syncAll'] as const)('gates %s with the resolved project and returns the result', async (method) => {
      const summary = { syncType: 'manual', issuesSynced: 1, issuesSkipped: 0, tickets: [{ ref: 'TEST-5', title: 'Issue' }] };
      gate.run.mockResolvedValue({ status: 'executed', result: summary });
      const result = method === 'syncIssue'
        ? await controller.syncIssue('test-project', '5', projectContext())
        : await controller.syncAll('test-project', projectContext());
      expect(result.data).toEqual(summary);
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({
        key: method === 'syncIssue' ? 'vcs.sync.issue' : 'vcs.sync.all',
        variant: method === 'syncIssue' ? 'rest:vcs.sync-issue' : 'rest:vcs.sync-all',
        projectId: 'proj-1', input: { slug: 'test-project', projectId: 'proj-1', ...(method === 'syncIssue' ? { issueNumber: '5' } : {}) },
      });
      expect(mockProjectsService.findBySlug).not.toHaveBeenCalled();
      expect(mockSyncService.fullSync).not.toHaveBeenCalled();
      expect(mockSyncService.syncIssue).not.toHaveBeenCalled();
    });
    it('AC-12: missing encryption key refuses full sync before gating', async () => {
      mockVcsConfig.encryptionKey = null;
      await expect(controller.syncAll('alpha', projectContext())).rejects.toThrow(ValidationAppException);
      await expect(controller.syncAll('alpha', projectContext())).rejects.toMatchObject({ prefix: 'vcs' });
      expect(gate.run).not.toHaveBeenCalled();
    });
    it('refuses single sync without a key before gating', async () => {
      mockVcsConfig.encryptionKey = null;
      await expect(controller.syncIssue('alpha', '7', projectContext())).rejects.toThrow(ValidationAppException);
      expect(gate.run).not.toHaveBeenCalled();
    });
    it.each(['syncIssue', 'syncAll'] as const)('throws pending for %s', async (method) => {
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });
      await expect(method === 'syncIssue' ? controller.syncIssue('alpha', '7', projectContext()) : controller.syncAll('alpha', projectContext())).rejects.toThrow(ApprovalPending);
    });
  });

  describe('syncPr', () => {
    it('should run PR sync and return updated count', async () => {
      gate.run.mockResolvedValue({ status: 'executed', result: { updated: 5, skipped: 1, extractions: ['private'] } });

      const result = await controller.syncPr('test-project', projectContext());
      expect(result.data).toEqual({ updated: 5 });
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'vcs.sync.pr', variant: 'rest:vcs.sync-pr', projectId: 'proj-1', input: { slug: 'test-project', projectId: 'proj-1' } });
      expect(mockPrSyncService.syncPrStatus).not.toHaveBeenCalled();
    });


    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(controller.syncPr('test-project', projectContext())).rejects.toThrow(ValidationAppException);
      expect(gate.run).not.toHaveBeenCalled();
    });
  });
});
