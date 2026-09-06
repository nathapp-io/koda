import { Test, TestingModule } from '@nestjs/testing';
import { AuthException } from '@nathapp/nestjs-common';
import { VcsWebhookController } from './vcs-webhook.controller';
import { ProjectsService } from '../projects/projects.service';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import type { VcsConnectionDomain } from './domain/vcs.domain';

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

function makeFullConnection(overrides?: Partial<VcsConnectionDomain>): VcsConnectionDomain {
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
  };
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

function makeRawRequest(rawBody: string | Buffer): { rawBody: Buffer } {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  return { rawBody: buf };
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
      const request = makeRawRequest(JSON.stringify(payload));

      const result = await controller.handleWebhook(
        'test-project',
        'sha256=valid-signature',
        payload,
        request,
        'push',
      );

      expect(mockProjectsService.findBySlug).toHaveBeenCalledWith('test-project');
      expect(mockVcsConnectionService.getFullByProject).toHaveBeenCalledWith('proj-1');
      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        request.rawBody.toString('utf8'),
        'sha256=valid-signature',
        'super-secret-webhook-key',
      );
      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-1', project: expect.objectContaining({ id: 'proj-1' }) }),
        'push',
        payload,
      );
      expect(result).toEqual({ success: true });
    });

    it('should verify against the raw request body bytes, not JSON.stringify of the parsed object (KODA-02)', async () => {
      // GitHub may send JSON in a different byte-order/whitespace than the
      // server-side re-serialization produces. The HMAC must be verified
      // against the raw bytes received, never against the parsed object.
      const canonicalJson = '{"action":"","ref":"refs/heads/main","commits":[]}';
      const payload: GitHubWebhookPayload = {
        action: '',
        ref: 'refs/heads/main',
        commits: [],
        repository: {
          id: 12345,
          full_name: 'owner/repo',
          name: 'repo',
          owner: { login: 'owner', id: 1 },
        },
        sender: { id: 1, login: 'dev', type: 'User' },
      };
      const request = makeRawRequest(canonicalJson);

      await controller.handleWebhook(
        'test-project',
        'sha256=sig',
        payload,
        request,
        'push',
      );

      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        canonicalJson,
        'sha256=sig',
        'super-secret-webhook-key',
      );
      // The body fed to verifySignature MUST NOT be the re-serialized JSON
      // of the parsed payload object (which would have different key order).
      const calledWith = mockWebhookService.verifySignature.mock.calls[0]?.[0] ?? '';
      expect(calledWith).not.toBe(JSON.stringify(payload));
    });

    it('should fall back to JSON.stringify(payload) when rawBody is absent (test/Express compatibility)', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook(
        'test-project',
        'sha256=sig',
        payload,
        {} as { rawBody?: Buffer },
        'push',
      );

      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        JSON.stringify(payload),
        'sha256=sig',
        'super-secret-webhook-key',
      );
    });

    it('should throw AuthException when connection has no webhookSecret', async () => {
      mockVcsConnectionService.getFullByProject.mockResolvedValue(makeFullConnection({ webhookSecret: null }));

      await expect(
        controller.handleWebhook(
          'test-project',
          'sha256=sig',
          makePushPayload(),
          makeRawRequest('{}'),
          'push',
        ),
      ).rejects.toThrow(AuthException);
    });

    it('should throw AuthException when the webhook signature is invalid', async () => {
      mockWebhookService.verifySignature.mockReturnValue(false);

      await expect(
        controller.handleWebhook(
          'test-project',
          'sha256=bad-signature',
          makePushPayload(),
          makeRawRequest('{}'),
          'push',
        ),
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

      await controller.handleWebhook(
        'test-project',
        'sha256=sig',
        issuePayload,
        makeRawRequest('{}'),
        undefined,
      );

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.anything(),
        'issues.opened',
        issuePayload,
      );
    });

    it('should pass the x-github-event header as event type when provided', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook(
        'test-project',
        'sha256=sig',
        payload,
        makeRawRequest('{}'),
        'ping',
      );

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

      await controller.handleWebhook(
        'test-project',
        'sha256=sig',
        prPayload,
        makeRawRequest('{}'),
        undefined,
      );

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(
        expect.anything(),
        'pull_request',
        prPayload,
      );
    });
  });
});
