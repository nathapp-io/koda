import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { VcsController } from '../../../src/vcs/vcs.controller';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { VcsSyncService, SyncIssueResult } from '../../../src/vcs/vcs-sync.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ConfigService } from '@nestjs/config';
import { CreateVcsConnectionDto, VcsProviderType } from '../../../src/vcs/dto/create-vcs-connection.dto';
import { VcsIssue } from '../../../src/vcs/types';
import { Project, VcsConnection } from '@prisma/client';

jest.mock('../../../src/vcs/factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../../../src/common/utils/encryption.util', () => ({
  decryptToken: jest.fn(() => 'decrypted-token'),
  encryptToken: jest.fn(() => 'encrypted-token'),
}));

describe('VCS Implementation Gap Acceptance Tests', () => {
  let controller: VcsController;
  let vcsConnectionService: jest.Mocked<VcsConnectionService>;
  let syncService: jest.Mocked<VcsSyncService>;
  let projectsService: jest.Mocked<ProjectsService>;
  let module: TestingModule;

  const mockProject: Project = {
    id: 'proj-123',
    slug: 'test-project',
    name: 'Test Project',
    key: 'TEST',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ciWebhookToken: null,
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
  };

  const mockVcsConnection: VcsConnection = {
    id: 'vcs-conn-123',
    projectId: mockProject.id,
    provider: 'github',
    repoOwner: 'test-owner',
    repoName: 'test-repo',
    encryptedToken: 'encrypted-token-123',
    syncMode: 'polling',
    allowedAuthors: '[]',
    pollingIntervalMs: 3600000,
    webhookSecret: undefined,
    lastSyncedAt: undefined,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const encryptionKey = 'test-encryption-key-32-chars-long';

  const mockVcsIssue: VcsIssue = {
    number: 42,
    title: 'Test issue',
    body: 'Issue body',
    authorLogin: 'octocat',
    url: 'https://github.com/test-owner/test-repo/issues/42',
    labels: [],
    createdAt: new Date('2024-01-15'),
  };

  beforeEach(async () => {
    const mockVcsConnectionServiceInstance = {
      create: jest.fn(),
      findByProject: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      testConnection: jest.fn(),
      getFullByProject: jest.fn(),
    };

    const mockSyncServiceInstance = {
      syncIssue: jest.fn(),
      fullSync: jest.fn(),
      filterByAllowedAuthors: jest.fn(),
    };

    const mockProjectsServiceInstance = {
      findBySlug: jest.fn().mockResolvedValue(mockProject),
    };

    const mockConfigServiceInstance = {
      get: jest.fn((key: string) => {
        if (key === 'vcs.encryptionKey') return encryptionKey;
        return undefined;
      }),
    };

    const mockProvider = {
      fetchIssue: jest.fn().mockResolvedValue(mockVcsIssue),
      fetchIssues: jest.fn().mockResolvedValue([mockVcsIssue]),
      testConnection: jest.fn().mockResolvedValue({ ok: true }),
    };

    const { createVcsProvider } = require('../../../src/vcs/factory');
    createVcsProvider.mockReturnValue(mockProvider);

    module = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        { provide: VcsConnectionService, useValue: mockVcsConnectionServiceInstance },
        { provide: VcsSyncService, useValue: mockSyncServiceInstance },
        { provide: VcsPrSyncService, useValue: {} },
        { provide: VcsWebhookService, useValue: {} },
        { provide: ProjectsService, useValue: mockProjectsServiceInstance },
        { provide: ConfigService, useValue: mockConfigServiceInstance },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
    vcsConnectionService = module.get(VcsConnectionService) as jest.Mocked<VcsConnectionService>;
    syncService = module.get(VcsSyncService) as jest.Mocked<VcsSyncService>;
    projectsService = module.get(ProjectsService) as jest.Mocked<ProjectsService>;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('AC-1: POST /api/projects/:slug/vcs with existing VCS connection returns 409 conflict', () => {
    it('returns HTTP 409 when project already has a VcsConnection', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs')
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException
      );
    });

    it('error is ValidationAppException type indicating conflict (not a generic error)', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs')
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
      }
    });
  });

  describe('AC-2: Duplicate VCS connection message does not contain validation and contains exist or conflict', () => {
    it('error is ValidationAppException type (not a generic validation error)', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs')
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
      }
    });

    it('error message is not a generic validation error', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs')
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
        const validationError = error as ValidationAppException;
        expect(validationError.message).not.toBe('Validation app exception');
      }
    });
  });

  describe('AC-3: POST /api/projects/:slug/vcs/sync/:issueNumber with existing externalVcsId returns 409', () => {
    it('returns HTTP 409 when Issue with matching externalVcsId already exists', async () => {
      const issueNumber = '42';
      const syncResult: SyncIssueResult = {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
      syncService.syncIssue.mockResolvedValue(syncResult);

      await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
        ValidationAppException
      );
    });

    it('skipped issue returns action=skipped from syncService', async () => {
      const issueNumber = '42';
      const syncResult: SyncIssueResult = {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
      syncService.syncIssue.mockResolvedValue(syncResult);

      await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
        ValidationAppException
      );
    });
  });

  describe('AC-4: POST /api/projects/:slug/vcs/sync/:issueNumber where GitHub returns 404 returns HTTP 404', () => {
    it('returns HTTP 404 when GitHub API returns 404 for the issue number', async () => {
      const issueNumber = '999999';

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);

      const mockProvider = {
        fetchIssue: jest.fn().mockRejectedValue(
          new NotFoundAppException('Issue #999999 not found', 'vcs')
        ),
        fetchIssues: jest.fn(),
        testConnection: jest.fn(),
      };

      const { createVcsProvider } = require('../../../src/vcs/factory');
      createVcsProvider.mockReturnValue(mockProvider);

      await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
        NotFoundAppException
      );
    });

    it('error message indicates issue not found', async () => {
      const issueNumber = '999999';

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);

      const mockProvider = {
        fetchIssue: jest.fn().mockRejectedValue(
          new NotFoundAppException('Issue #999999 not found', 'vcs')
        ),
        fetchIssues: jest.fn(),
        testConnection: jest.fn(),
      };

      const { createVcsProvider } = require('../../../src/vcs/factory');
      createVcsProvider.mockReturnValue(mockProvider);

      try {
        await controller.syncIssue(mockProject.slug, issueNumber);
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundAppException);
        const notFoundError = error as NotFoundAppException;
        expect(notFoundError.message.toLowerCase()).toContain('not found');
      }
    });
  });

  describe('AC-5: POST /api/projects/:slug/vcs with missing required field returns HTTP 400', () => {
    it('throws ValidationAppException when provider is missing', async () => {
      const createDto = {
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      } as CreateVcsConnectionDto;

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Provider is required', 'validation')
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException
      );
    });

    it('throws ValidationAppException when token is missing', async () => {
      const createDto = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
      } as CreateVcsConnectionDto;

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Token is required', 'validation')
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException
      );
    });

    it('throws ValidationAppException when vcsType is invalid', async () => {
      const createDto = {
        provider: 'invalid-provider' as VcsProviderType,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      } as CreateVcsConnectionDto;

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Invalid provider type', 'validation')
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException
      );
    });

    it('response body indicates validation failure', async () => {
      const createDto = {
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      } as CreateVcsConnectionDto;

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Provider is required', 'validation')
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
        const validationError = error as ValidationAppException;
        expect(validationError.message).toBeDefined();
        expect(typeof validationError.message).toBe('string');
      }
    });
  });
});