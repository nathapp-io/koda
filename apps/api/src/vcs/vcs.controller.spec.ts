import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { VCS_CFG } from '../config/vcs.config';
import { VcsController } from './vcs.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { ProjectsService } from '../projects/projects.service';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import type { VcsConnectionDomain } from './domain/vcs.domain';

jest.mock('./factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../common/utils/encryption.util', () => ({
  decryptToken: jest.fn().mockReturnValue('plain-token'),
  encryptToken: jest.fn().mockReturnValue('enc-token'),
}));

import { createVcsProvider } from './factory';

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
    webhookSecret: null,
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
  let mockProjectsService: jest.Mocked<Pick<ProjectsService, 'findBySlug'>>;
  let mockVcsService: jest.Mocked<Pick<VcsConnectionService, 'create' | 'findByProject' | 'update' | 'delete' | 'testConnection' | 'getFullByProject'>>;
  let mockSyncService: jest.Mocked<Pick<VcsSyncService, 'syncIssue' | 'fullSync'>>;
  let mockPrSyncService: jest.Mocked<Pick<VcsPrSyncService, 'syncPrStatus'>>;
  let mockVcsConfig: { encryptionKey: string | null };

  const encryptionKey = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockProjectsService = {
      findBySlug: jest.fn().mockResolvedValue(makeProjectDto()),
    };

    mockVcsService = {
      create: jest.fn().mockResolvedValue(makeConnectionResponse()),
      findByProject: jest.fn().mockResolvedValue(makeConnectionResponse()),
      update: jest.fn().mockResolvedValue(makeConnectionResponse()),
      delete: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockResolvedValue({ ok: true, latencyMs: 42 }),
      getFullByProject: jest.fn().mockResolvedValue(makeFullConnection()),
    };

    mockSyncService = {
      syncIssue: jest.fn().mockResolvedValue({ action: 'created', ticketId: 't-1', ticketNumber: 5, ticketTitle: 'Issue title' }),
      fullSync: jest.fn().mockResolvedValue({ issuesSynced: 2, issuesSkipped: 1, createdTickets: [{ id: 't-1', number: 5, title: 'Issue title' }], errors: [] }),
    };

    mockPrSyncService = {
      syncPrStatus: jest.fn().mockResolvedValue({ updated: 3, skipped: 0 }),
    };

    mockVcsConfig = {
      encryptionKey,
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        { provide: VcsConnectionService, useValue: mockVcsService },
        { provide: VcsSyncService, useValue: mockSyncService },
        { provide: VcsPrSyncService, useValue: mockPrSyncService },
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: VCS_CFG, useValue: mockVcsConfig },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      expect(result).toBeDefined();
      expect(result.id).toBe('conn-1');
    });

    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(
        controller.createConnection('test-project', {} as CreateVcsConnectionDto),
      ).rejects.toThrow(ValidationAppException);
    });
  });

  describe('getConnection', () => {
    it('should resolve the project by slug and return the connection', async () => {
      const result = await controller.getConnection('test-project');

      expect(mockProjectsService.findBySlug).toHaveBeenCalledWith('test-project');
      expect(mockVcsService.findByProject).toHaveBeenCalledWith('proj-1');
      expect(result.id).toBe('conn-1');
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
  });

  describe('deleteConnection', () => {
    it('should resolve the project by slug and delete the connection', async () => {
      await controller.deleteConnection('test-project');

      expect(mockProjectsService.findBySlug).toHaveBeenCalledWith('test-project');
      expect(mockVcsService.delete).toHaveBeenCalledWith('proj-1');
    });
  });

  describe('testConnection', () => {
    it('should return test result from vcsService.testConnection', async () => {
      mockVcsService.testConnection.mockResolvedValue({ ok: true, latencyMs: 100 });

      const result = await controller.testConnection('test-project');

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBe(100);
      expect(mockVcsService.testConnection).toHaveBeenCalledWith('proj-1', encryptionKey);
    });

    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(controller.testConnection('test-project')).rejects.toThrow(ValidationAppException);
    });
  });

  describe('syncIssue', () => {
    it('should fetch the issue and create a ticket, returning the sync result', async () => {
      const mockProvider = {
        fetchIssue: jest.fn().mockResolvedValue({
          number: 5,
          title: 'Issue title',
          body: 'Body',
          authorLogin: 'alice',
          url: 'https://github.com/owner/repo/issues/5',
          labels: [],
          createdAt: new Date(),
        }),
        fetchIssues: jest.fn(),
        testConnection: jest.fn(),
        getPullRequestStatus: jest.fn(),
        listPrCommits: jest.fn(),
      };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      mockSyncService.syncIssue.mockResolvedValue({ action: 'created', ticketId: 't-1', ticketNumber: 5, ticketTitle: 'Issue title' });

      const result = await controller.syncIssue('test-project', '5');

      expect(mockProvider.fetchIssue).toHaveBeenCalledWith(5);
      expect(mockSyncService.syncIssue).toHaveBeenCalled();
      expect(result.syncType).toBe('manual');
      expect(result.issuesSynced).toBe(1);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].ref).toContain('TEST-5');
    });

    it('should throw 409 CONFLICT when the issue is already synced', async () => {
      const mockProvider = {
        fetchIssue: jest.fn().mockResolvedValue({
          number: 5,
          title: 'Existing issue',
          body: null,
          authorLogin: 'alice',
          url: 'https://github.com/owner/repo/issues/5',
          labels: [],
          createdAt: new Date(),
        }),
        fetchIssues: jest.fn(),
        testConnection: jest.fn(),
        getPullRequestStatus: jest.fn(),
        listPrCommits: jest.fn(),
      };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      mockSyncService.syncIssue.mockResolvedValue({ action: 'skipped', reason: 'already exists' });

      await expect(controller.syncIssue('test-project', '5')).rejects.toThrow(
        new HttpException('Issue already synced', HttpStatus.CONFLICT),
      );
    });

    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(controller.syncIssue('test-project', '5')).rejects.toThrow(ValidationAppException);
    });
  });

  describe('syncAll', () => {
    it('should run a full sync and return the summary', async () => {
      mockSyncService.fullSync.mockResolvedValue({
        issuesSynced: 3,
        issuesSkipped: 1,
        createdTickets: [{ id: 't-1', number: 7, title: 'Issue 7' }],
        errors: [],
      });

      const result = await controller.syncAll('test-project');

      expect(result.syncType).toBe('manual');
      expect(result.issuesSynced).toBe(3);
      expect(result.issuesSkipped).toBe(1);
      expect(result.tickets[0].ref).toBe('TEST-7');
      expect(result.tickets[0].title).toBe('Issue 7');
    });

    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(controller.syncAll('test-project')).rejects.toThrow(ValidationAppException);
    });
  });

  describe('syncPr', () => {
    it('should run PR sync and return updated count', async () => {
      mockPrSyncService.syncPrStatus.mockResolvedValue({ updated: 5, skipped: 1 });

      const result = await controller.syncPr('test-project');

      expect(result.updated).toBe(5);
      expect(mockPrSyncService.syncPrStatus).toHaveBeenCalled();
    });

    it('should throw ValidationAppException when encryption key is not configured', async () => {
      mockVcsConfig.encryptionKey = null;

      await expect(controller.syncPr('test-project')).rejects.toThrow(ValidationAppException);
    });
  });
});
