import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AuthException } from '@nathapp/nestjs-common';
import { VcsWebhookController } from './vcs-webhook.controller';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import type { InboundWebhookRequest } from '../webhook-security/inbound-webhook-request';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';

function makeTarget(overrides?: Partial<VcsConnectionWithProjectDomain>): VcsConnectionWithProjectDomain {
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
    project: { id: 'proj-1', key: 'TEST', slug: 'test-project' },
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

/** A Fastify-shaped request: the raw bytes the sender signed plus the parsed body. */
function makeRequest(body: unknown, rawBody: string = JSON.stringify(body)): InboundWebhookRequest {
  return { rawBody: Buffer.from(rawBody), body };
}

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected the call to reject');
}

describe('VcsWebhookController', () => {
  let controller: VcsWebhookController;
  let mockVcsConnectionService: Mocked<Pick<VcsConnectionService, 'findInboundTarget'>>;
  let mockWebhookService: Mocked<Pick<VcsWebhookService, 'verifySignature' | 'handleWebhook'>>;
  let mockReplayGuard: { assertFresh: Mock; forget: Mock };

  beforeEach(async () => {
    mockVcsConnectionService = {
      findInboundTarget: vi.fn().mockResolvedValue(makeTarget()),
    };

    mockWebhookService = {
      verifySignature: vi.fn().mockReturnValue(true),
      handleWebhook: vi.fn().mockResolvedValue({ success: true }),
    };

    mockReplayGuard = {
      assertFresh: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VcsWebhookController],
      providers: [
        { provide: VcsConnectionService, useValue: mockVcsConnectionService },
        { provide: VcsWebhookService, useValue: mockWebhookService },
        { provide: WebhookReplayGuard, useValue: mockReplayGuard },
      ],
    }).compile();

    controller = module.get<VcsWebhookController>(VcsWebhookController);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** The 401 a caller gets for a bad signature on an existing connection: the reference shape. */
  async function badSignatureRejection(): Promise<HttpException> {
    mockWebhookService.verifySignature.mockReturnValueOnce(false);
    return rejectionOf(controller.handleWebhook('test-project', 'sha256=bad', makeRequest(makePushPayload()), 'push'));
  }

  describe('happy path', () => {
    it('resolves the connection by slug in one lookup and forwards a valid push webhook', async () => {
      const payload = makePushPayload();
      const request = makeRequest(payload);

      const result = await controller.handleWebhook('test-project', 'sha256=valid-signature', request, 'push');

      const expectedBytes = request.rawBody ?? Buffer.alloc(0);
      expect(mockVcsConnectionService.findInboundTarget).toHaveBeenCalledTimes(1);
      expect(mockVcsConnectionService.findInboundTarget).toHaveBeenCalledWith('test-project');
      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        expectedBytes.toString('utf8'),
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

    it('verifies against the raw request body bytes, not JSON.stringify of the parsed body (KODA-02)', async () => {
      const canonicalJson = '{"action":"","ref":"refs/heads/main","commits":[]}';
      const payload = makePushPayload({ commits: [] });

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(payload, canonicalJson), 'push');

      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        canonicalJson,
        'sha256=sig',
        'super-secret-webhook-key',
      );
      const calledWith = mockWebhookService.verifySignature.mock.calls[0]?.[0] ?? '';
      expect(calledWith).not.toBe(JSON.stringify(payload));
    });

    it('falls back to JSON.stringify(body) when rawBody is absent (Express test setups)', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook('test-project', 'sha256=sig', { body: payload }, 'push');

      expect(mockWebhookService.verifySignature).toHaveBeenCalledWith(
        JSON.stringify(payload),
        'sha256=sig',
        'super-secret-webhook-key',
      );
    });

    it('treats a signed non-object body as an empty payload instead of crashing', async () => {
      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(null, 'null'), undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'unknown', {});
    });
  });

  describe('every inbound auth failure is the same 401 (no slug enumeration)', () => {
    it('a bad signature is an AuthException 401 and processes nothing', async () => {
      const err = await badSignatureRejection();

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown slug, a deleted project, or no connection', null],
      ['a connection without a webhook secret', makeTarget({ webhookSecret: null })],
      ['a connection with an empty-string webhook secret', makeTarget({ webhookSecret: '' })],
    ])('%s gets the identical 401', async (_label, target) => {
      const reference = await badSignatureRejection();
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(target);

      const err = await rejectionOf(
        controller.handleWebhook('test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push'),
      );

      expect(err).toBeInstanceOf(AuthException);
      expect(err.getStatus()).toBe(401);
      expect(err.getResponse()).toEqual(reference.getResponse());
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
    });
  });

  describe('connection-state gate', () => {
    it('returns 200 { ignored } for an inactive connection without processing or recording the delivery', async () => {
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(makeTarget({ isActive: false }));

      const result = await controller.handleWebhook(
        'test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-1',
      );

      expect(result).toEqual({ success: true, ignored: true, reason: 'VCS connection is inactive' });
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each(['off', 'polling'])("returns 200 { ignored } when syncMode is '%s'", async (syncMode) => {
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(makeTarget({ syncMode }));

      const result = await controller.handleWebhook(
        'test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-1',
      );

      expect(result).toEqual({
        success: true,
        ignored: true,
        reason: `VCS connection syncMode is '${syncMode}'; webhook deliveries are processed only in 'webhook' mode`,
      });
      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
      expect(mockReplayGuard.assertFresh).not.toHaveBeenCalled();
    });

    it.each([
      ['an inactive connection', makeTarget({ isActive: false })],
      ['a polling connection', makeTarget({ syncMode: 'polling' })],
    ])('checks the signature first: %s with a bad signature is the 401, not the ignored 200', async (_label, target) => {
      mockVcsConnectionService.findInboundTarget.mockResolvedValueOnce(target);
      mockWebhookService.verifySignature.mockReturnValueOnce(false);

      await expect(
        controller.handleWebhook('test-project', 'sha256=bad', makeRequest(makePushPayload()), 'push'),
      ).rejects.toThrow(AuthException);
    });
  });

  describe('event type', () => {
    it('infers "issues.opened" from the payload when the x-github-event header is absent', async () => {
      const issuePayload: GitHubWebhookPayload = {
        action: 'opened',
        issue: { number: 1, title: 'Bug', body: null, user: { login: 'dev' }, html_url: 'url', labels: [], created_at: '' },
        repository: { id: 1, full_name: 'owner/repo', name: 'repo', owner: { login: 'owner', id: 1 } },
        sender: { id: 1, login: 'dev', type: 'User' },
      };

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(issuePayload), undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'issues.opened', issuePayload);
    });

    it('passes the x-github-event header as the event type when provided', async () => {
      const payload = makePushPayload();

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(payload), 'ping');

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'ping', payload);
    });

    it('infers "pull_request" when the payload has pull_request and no header', async () => {
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
        repository: { id: 1, full_name: 'owner/repo', name: 'repo', owner: { login: 'owner', id: 1 } },
        sender: { id: 1, login: 'dev', type: 'User' },
      };

      await controller.handleWebhook('test-project', 'sha256=sig', makeRequest(prPayload), undefined);

      expect(mockWebhookService.handleWebhook).toHaveBeenCalledWith(expect.anything(), 'pull_request', prPayload);
    });
  });

  describe('replay protection (SEC-1)', () => {
    it('passes the delivery id and the resolved project id to the replay guard', async () => {
      await controller.handleWebhook(
        'test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-uuid-001',
      );

      expect(mockReplayGuard.assertFresh).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'github',
        deliveryId: 'delivery-uuid-001',
        dateHeader: undefined,
      });
    });

    it('propagates 409 when the delivery is a replay and skips processing', async () => {
      mockReplayGuard.assertFresh.mockRejectedValueOnce(new HttpException('Webhook already processed', 409));

      await expect(
        controller.handleWebhook('test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-dup'),
      ).rejects.toMatchObject({ status: 409 });

      expect(mockWebhookService.handleWebhook).not.toHaveBeenCalled();
    });

    it('forgets the delivery when processing throws so GitHub retries are accepted', async () => {
      mockWebhookService.handleWebhook.mockRejectedValueOnce(new Error('db down'));

      await expect(
        controller.handleWebhook('test-project', 'sha256=sig', makeRequest(makePushPayload()), 'push', 'delivery-retry-1'),
      ).rejects.toThrow('db down');

      expect(mockReplayGuard.forget).toHaveBeenCalledWith({
        projectId: 'proj-1',
        source: 'github',
        deliveryId: 'delivery-retry-1',
      });
    });
  });
});
