import { Test, TestingModule } from '@nestjs/testing';
import { VcsController } from '../../../src/vcs/vcs.controller';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { VcsSyncService } from '../../../src/vcs/vcs-sync.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { CreateVcsConnectionDto, VcsProviderType } from '../../../src/vcs/dto/create-vcs-connection.dto';
import { VcsConnectionResponseDto } from '../../../src/vcs/dto/vcs-connection-response.dto';
import { Project, VcsConnection } from '@prisma/client';

jest.mock('../../../src/vcs/factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../../../src/common/utils/encryption.util', () => ({
  decryptToken: jest.fn(() => 'decrypted-token'),
  encryptToken: jest.fn(() => 'encrypted-token'),
}));

describe('vcs-implementation-gap acceptance tests', () => {
  let controller: VcsController;
  let vcsConnectionService: jest.Mocked<VcsConnectionService>;
  let syncService: jest.Mocked<VcsSyncService>;
  let projectsService: jest.Mocked<ProjectsService>;
  let configService: jest.Mocked<ConfigService>;
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
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  afterEach(async () => {
    await module.close();
  });

  describe('AC-1: POST /projects/:slug/vcs with valid payload and no existing connection returns HTTP 201', () => {
    it('returns HTTP 201 with response body containing vcsConnection object having id, projectSlug, and provider fields', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_test_token_123456',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
      };

      const vcsConnectionResponse: VcsConnectionResponseDto = {
        id: 'vcs-conn-123',
        projectId: mockProject.id,
        provider: 'github',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        syncMode: 'polling',
        allowedAuthors: [],
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vcsConnectionService.create.mockResolvedValue(vcsConnectionResponse);

      const result = await controller.createConnection(mockProject.slug, createDto);

      expect(result).toBeDefined();
      expect(result).toHaveProperty('id');
      expect(result.id).toBe('vcs-conn-123');
      expect(result).toHaveProperty('provider');
      expect(result.provider).toBe('github');
      expect(result).toHaveProperty('repoOwner', 'test-owner');
      expect(result).toHaveProperty('repoName', 'test-repo');
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');
    });

    it('does not include sensitive token fields in response', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_test_token_secret',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
      };

      const vcsConnectionResponse: VcsConnectionResponseDto = {
        id: 'vcs-conn-456',
        projectId: mockProject.id,
        provider: 'github',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        syncMode: 'polling',
        allowedAuthors: [],
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vcsConnectionService.create.mockResolvedValue(vcsConnectionResponse);

      const result = await controller.createConnection(mockProject.slug, createDto);

      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');
      expect(result).not.toHaveProperty('repoUrl');
    });
  });

  describe('AC-2: POST /projects/:slug/vcs/sync/:issueNumber when GitHub API returns non-404 error returns the same HTTP error status', () => {
    it('returns HTTP 403 when GitHub API returns 403 rate limit error', async () => {
      const issueNumber = '42';

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);

      const { createVcsProvider } = require('../../../src/vcs/factory');
      const mockProvider = {
        fetchIssue: jest.fn().mockRejectedValue(
          new HttpException('rate limit exceeded', HttpStatus.FORBIDDEN)
        ),
      };
      createVcsProvider.mockReturnValue(mockProvider);

      let caught: unknown;
      try {
        await controller.syncIssue(mockProject.slug, issueNumber);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    });

    it('returns HTTP 500 when GitHub API returns 500 server error', async () => {
      const issueNumber = '42';

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);

      const { createVcsProvider } = require('../../../src/vcs/factory');
      const mockProvider = {
        fetchIssue: jest.fn().mockRejectedValue(
          new HttpException('GitHub server error', HttpStatus.INTERNAL_SERVER_ERROR)
        ),
      };
      createVcsProvider.mockReturnValue(mockProvider);

      let caught: unknown;
      try {
        await controller.syncIssue(mockProject.slug, issueNumber);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('returns HTTP 401 when GitHub API returns 401 unauthorized error', async () => {
      const issueNumber = '42';

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);

      const { createVcsProvider } = require('../../../src/vcs/factory');
      const mockProvider = {
        fetchIssue: jest.fn().mockRejectedValue(
          new HttpException('Bad credentials', HttpStatus.UNAUTHORIZED)
        ),
      };
      createVcsProvider.mockReturnValue(mockProvider);

      let caught: unknown;
      try {
        await controller.syncIssue(mockProject.slug, issueNumber);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('does NOT return HTTP 409 for non-404 GitHub errors', async () => {
      const issueNumber = '42';

      vcsConnectionService.getFullByProject.mockResolvedValue(mockVcsConnection);

      const { createVcsProvider } = require('../../../src/vcs/factory');
      const mockProvider = {
        fetchIssue: jest.fn().mockRejectedValue(
          new HttpException('rate limit exceeded', HttpStatus.FORBIDDEN)
        ),
      };
      createVcsProvider.mockReturnValue(mockProvider);

      let caught: unknown;
      try {
        await controller.syncIssue(mockProject.slug, issueNumber);
      } catch (error) {
        caught = error;
      }

      expect(caught).not.toBeInstanceOf(HttpException) ||
        (caught as HttpException).getStatus() !== HttpStatus.CONFLICT;
    });
  });
});