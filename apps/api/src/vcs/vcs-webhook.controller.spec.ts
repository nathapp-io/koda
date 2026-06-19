import { Test, TestingModule } from '@nestjs/testing';
import { AuthException } from '@nathapp/nestjs-common';
import { VcsWebhookController } from './vcs-webhook.controller';
import { ProjectsService } from '../projects/projects.service';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import { VcsConnection } from '@prisma/client';

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

function makeFullConnection(overrides?: Partial<VcsConnection>): VcsConnection {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'webhook',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: 'super-secret-webhook-key',
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as VcsConnection;
}

function makePushPayload(overrides?: Partial<GitHubWebhookPayload>): GitHubWebhookPayload {
  return {
    action: '',
    repository: {
      id: 12345,
      full_name: 'owner/repo',
      name: 'repo',
      owner: { login: 'owner', id: 1 },
    },
    ref: 'refs/heads/main',
    commits: [
      {
        id: 'abc123',
        message: 'fix: bug',
        timestamp: '2024-01-01T00:00:00Z',
        author: { name: 'Dev', email: 'dev@example.com', username: 'dev' },
        added: [],
        removed: [],
        modified: [],
      },
    ],
    sender: { id: 1, login: 'dev', type: 'User' },
    ...overrides,
  };
}

describe('VcsWebhookController', () => {
  let controller: VcsWebhookController;
  let mockProjectsService: jest.Mocked<Pick<ProjectsService, 'findBySlug'>>;
  let mockVcsConnectionService: jest.Mocked<Pick<VcsConnectionService, 'getFullByProject'>>;
  let mockWebhookService: jest.Mocked<Pick<VcsWebhookService, 'verifySignature' | 'handleWebhook'>>;

  beforeEach(async () => {
    mockProjectsService = {
      findBySlug: jest.fn().mockResolvedValue(makeProjectDto()),
    };

    mockVcsConnectionService = {
      getFullByProject: jest.fn().mockResolvedValue(makeFullConnection()),
    };

    mockWebhookService = {
      verifySignature: jest.fn().mockReturnValue(true),
      handleWebhook: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VcsWebhookController],
      providers: [
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: VcsConnectionService, useValue: mockVcsConnectionService },
        { provide: VcsWebhookService, useValue: mockWebhookService },
      ],
    }).compile();

    controller = module.get<VcsWebhookController>(VcsWebhookController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleWebhook', () => {
    it('should resolve the project and connection and forward a valid push webhook', async () => {
      const payload = makePushPayload();

      const result = await controller.handleWebhook(
        'test-project',
        'sha256=valid-signature',
        payload,
        'push',
      );

      expect(mockProjectsService.findBySlug).toHaveBeenCalledWith('test-project');
      expect(mockVcsConnectionService.getFullByProject).toHaveBeenCalledWith('proj-1');
      expect(mockWebhookService.verifySignature).toHaveBeenCalled();
      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-1', project: expect.objectContaining({ id: 'proj-1' }) }),
        'push',
        payload,
      );
      expect(result).toEqual({ success: true });
    });

    it('should throw AuthException when connection has no webhookSecret', async () => {
      mockVcsConnectionService.getFullByProject.mockResolvedValue(makeFullConnection({ webhookSecret: null }));

      await expect(
        controller.handleWebhook('test-project', 'sha256=sig', makePushPayload(), 'push'),
      ).rejects.toThrow(AuthException);
    });

    it('should throw AuthException when the webhook signature is invalid', async () => {
      mockWebhookService.verifySignature.mockReturnValue(false);

      await expect(
        controller.handleWebhook('test-project', 'sha256=bad-signature', makePushPayload(), 'push'),
      ).rejects.toThrow(AuthException);

      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
    });

    it('should infer event type as "issues.opened" from payload when x-github-event header is absent and action is set', async () => {
      const issuePayload: GitHubWebhookPayload = {
        action: 'opened',
        issue: { number: 1, title: 'Bug', body: null, user: { login: 'dev' }, html_url: 'url', labels: [], created_at: '' },
        repository: {
          id: 1,
          full_name: 'owner/repo',
          name: 'repo',
          owner: { login: 'owner', id: 1 },
        },
        sender: { id: 1, login: 'dev', type: 'User' },
      };

      await controller.handleWebhook('test-project', 'sha256=sig', issuePayload, undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.anything(),
        'issues.opened',
        issuePayload,
      );
    });

    it('should pass the x-github-event header as event type when provided', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook('test-project', 'sha256=sig', payload, 'ping');

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.anything(),
        'ping',
        payload,
      );
    });

    it('should infer event type as "pull_request" when payload has pull_request and no header', async () => {
      const prPayload: GitHubWebhookPayload = {
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'PR title',
          state: 'open',
          draft: false,
          merged: false,
          merged_at: null,
          merged_by: null,
          merge_commit_sha: null,
          html_url: 'url',
          head: { ref: 'feature/branch', repo: { full_name: 'owner/repo' } },
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          user: { login: 'dev' },
          body: null,
        },
        repository: {
          id: 1,
          full_name: 'owner/repo',
          name: 'repo',
          owner: { login: 'owner', id: 1 },
        },
        sender: { id: 1, login: 'dev', type: 'User' },
      };

      await controller.handleWebhook('test-project', 'sha256=sig', prPayload, undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.anything(),
        'pull_request',
        prPayload,
      );
    });
  });
});
