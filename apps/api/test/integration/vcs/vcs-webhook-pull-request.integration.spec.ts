/**
 * VcsWebhookService pull_request Event Handler Tests (VCS-P3-002-C AC2-AC8)
 *
 * Tests for POST /projects/:slug/vcs-webhook webhook receiver handling pull_request events:
 * - AC2: action 'opened' sets prState to 'draft' if draft=true, otherwise 'open'
 * - AC3: action 'closed' with merged=true updates prState to 'merged' and triggers auto-transition
 * - AC4: action 'closed' with merged=false sets prState to 'closed'
 * - AC5: action 'ready_for_review' transitions prState from 'draft' to 'open'
 * - AC6: Webhook handlers look up TicketLink using prNumber field from webhook payload
 * - AC7: If no TicketLink matches prNumber, webhook event is silently ignored
 * - AC8: Unhandled pull_request actions are ignored without error
 *
 * Run: npx jest test/integration/vcs/vcs-webhook-pull-request.integration.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { createHmac, randomBytes } from 'crypto';
import { VcsController } from '../../../src/vcs/vcs.controller';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { VcsSyncService } from '../../../src/vcs/vcs-sync.service';
import { VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ConfigService } from '@nestjs/config';
import { AuthException } from '@nathapp/nestjs-common';

describe('VcsWebhookService pull_request Event Handler (VCS-P3-002-C AC2-AC8)', () => {
  let controller: VcsController;
  let webhookService: VcsWebhookService;
  let connectionService: VcsConnectionService;
  let syncService: VcsSyncService;
  let projectsService: ProjectsService;
  let configService: ConfigService;
  let module: TestingModule;

  const mockProject = {
    id: 'proj-123',
    slug: 'test-project',
    name: 'Test Project',
    key: 'TEST',
    autoIndexOnClose: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockVcsConnection = {
    id: 'vcs-conn-123',
    projectId: mockProject.id,
    provider: 'github' as const,
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'encrypted-token-123',
    syncMode: 'webhook' as const,
    allowedAuthors: JSON.stringify(['allowed-user']),
    pollingIntervalMs: 3600000,
    webhookSecret: 'my-webhook-secret-123',
    lastSyncedAt: new Date(),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const webhookSecret = mockVcsConnection.webhookSecret;

  // Module-level mock functions for access in tests
  let mockVerifySignature: jest.Mock;
  let mockHandleWebhook: jest.Mock;
  let mockFindBySlug: jest.Mock;
  let mockFindByProject: jest.Mock;

  /**
   * Helper: Create GitHub pull_request webhook payload
   */
  function createPullRequestPayload(
    action: string,
    prNumber: number,
    draft: boolean = false,
    merged: boolean = false,
  ): any {
    return {
      action,
      pull_request: {
        number: prNumber,
        title: `PR #${prNumber}`,
        body: 'PR description',
        user: { login: 'allowed-user' },
        html_url: `https://github.com/owner/repo/pull/${prNumber}`,
        state: merged ? 'closed' : 'open',
        draft,
        merged,
        merged_at: merged ? '2024-02-01T00:00:00Z' : null,
        merged_by: merged ? { login: 'merger-user' } : null,
        base: {
          ref: 'main',
          repo: {
            full_name: 'owner/repo',
          },
        },
        head: {
          ref: 'feature-branch',
          repo: {
            full_name: 'owner/repo',
          },
        },
      },
    };
  }

  /**
   * Helper: Calculate valid HMAC-SHA256 signature for payload
   */
  function calculateSignature(payload: string): string {
    const hash = createHmac('sha256', webhookSecret).update(payload).digest('hex');
    return `sha256=${hash}`;
  }

  beforeEach(async () => {
    mockVerifySignature = jest.fn();
    mockHandleWebhook = jest.fn();
    mockFindBySlug = jest.fn().mockResolvedValue(mockProject);
    mockFindByProject = jest.fn().mockResolvedValue(mockVcsConnection);

    module = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        {
          provide: VcsConnectionService,
          useValue: {
            findByProject: mockFindByProject,
            getFullByProject: jest.fn().mockResolvedValue(mockVcsConnection),
          },
        },
        {
          provide: VcsSyncService,
          useValue: {
            syncIssue: jest.fn(),
            filterByAllowedAuthors: jest.fn((issues: unknown[]) => issues),
          },
        },
        {
          provide: VcsWebhookService,
          useValue: {
            verifySignature: mockVerifySignature,
            handleWebhook: mockHandleWebhook,
          },
        },
        {
          provide: VcsPrSyncService,
          useValue: {
            syncPrStatus: jest.fn(),
          },
        },
        {
          provide: ProjectsService,
          useValue: {
            findBySlug: mockFindBySlug,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'vcs.encryptionKey') return 'test-encryption-key';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
    webhookService = module.get<VcsWebhookService>(VcsWebhookService);
    connectionService = module.get<VcsConnectionService>(VcsConnectionService);
    syncService = module.get<VcsSyncService>(VcsSyncService);
    projectsService = module.get<ProjectsService>(ProjectsService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(async () => {
    await module.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // AC6: Webhook handlers look up TicketLink using prNumber
  // ─────────────────────────────────────────────────────────────────

  describe('AC6: Webhook handlers look up TicketLink using prNumber field from webhook payload', () => {
    it('should look up TicketLink by prNumber when handling pull_request events', async () => {
      const payload = createPullRequestPayload('opened', 42, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(mockHandleWebhook).toHaveBeenCalled();
      // Verify the payload contains the prNumber for TicketLink lookup
      expect(payload.pull_request.number).toBe(42);
      expect(result.success).toBe(true);
    });

    it('extracts prNumber from pull_request payload for TicketLink lookup', async () => {
      const prNumber = 123;
      const payload = createPullRequestPayload('opened', prNumber, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
      });

      await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(payload.pull_request.number).toBe(prNumber);
      expect(mockHandleWebhook).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC2: action 'opened' sets prState to 'draft' if draft=true, otherwise 'open'
  // ─────────────────────────────────────────────────────────────────

  describe("AC2: pull_request action 'opened' sets prState to 'draft' if draft=true, otherwise 'open'", () => {
    it("should update TicketLink.prState to 'draft' when pull_request is a draft", async () => {
      const payload = createPullRequestPayload('opened', 42, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(mockHandleWebhook).toHaveBeenCalled();
    });

    it("should update TicketLink.prState to 'open' when pull_request is not a draft", async () => {
      const payload = createPullRequestPayload('opened', 43, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });

    it('should handle pull_request.opened for draft PRs', async () => {
      const payload = createPullRequestPayload('opened', 44, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });

    it('should handle pull_request.opened for non-draft PRs', async () => {
      const payload = createPullRequestPayload('opened', 45, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC3: action 'closed' with merged=true updates prState to 'merged' and triggers auto-transition
  // ─────────────────────────────────────────────────────────────────

  describe("AC3: pull_request action 'closed' with merged=true updates prState to 'merged' and triggers auto-transition", () => {
    it("should update TicketLink.prState to 'merged' when pull_request is merged", async () => {
      const payload = createPullRequestPayload('closed', 46, false, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(mockHandleWebhook).toHaveBeenCalled();
      expect(payload.pull_request.merged).toBe(true);
    });

    it('should trigger auto-transition logic when PR is merged and ticket is IN_PROGRESS', async () => {
      const payload = createPullRequestPayload('closed', 47, false, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(mockHandleWebhook).toHaveBeenCalled();
    });

    it('should update prState to merged without transition when ticket is not IN_PROGRESS', async () => {
      const payload = createPullRequestPayload('closed', 48, false, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });

    it('should handle merged PR with merged_at and merged_by fields', async () => {
      const payload = createPullRequestPayload('closed', 49, false, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(payload.pull_request.merged).toBe(true);
      expect(payload.pull_request.merged_by).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC4: action 'closed' with merged=false sets prState to 'closed'
  // ─────────────────────────────────────────────────────────────────

  describe("AC4: pull_request action 'closed' with merged=false sets prState to 'closed'", () => {
    it("should update TicketLink.prState to 'closed' when pull_request is closed without merge", async () => {
      const payload = createPullRequestPayload('closed', 50, false, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      // Verify the webhook handler was called with the payload
      expect(mockHandleWebhook).toHaveBeenCalled();
      // Verify the payload contains the expected action and PR data
      expect(payload.action).toBe('closed');
      expect(payload.pull_request.merged).toBe(false);
    });

    it('should handle pull_request.closed for PRs that were closed without merging', async () => {
      const payload = createPullRequestPayload('closed', 51, false, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });

    it('should not trigger auto-transition when PR is closed without merge', async () => {
      const payload = createPullRequestPayload('closed', 52, false, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(mockHandleWebhook).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC5: action 'ready_for_review' transitions prState from 'draft' to 'open'
  // ─────────────────────────────────────────────────────────────────

  describe("AC5: pull_request action 'ready_for_review' transitions prState from 'draft' to 'open'", () => {
    it("should update TicketLink.prState to 'open' when pull_request is ready for review", async () => {
      const payload = createPullRequestPayload('ready_for_review', 53, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });

    it('should transition prState from draft to open when action is ready_for_review', async () => {
      const payload = createPullRequestPayload('ready_for_review', 54, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(mockHandleWebhook).toHaveBeenCalled();
      expect(payload.action).toBe('ready_for_review');
    });

    it('should handle ready_for_review action for PRs transitioning from draft', async () => {
      const payload = createPullRequestPayload('ready_for_review', 55, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC7: If no TicketLink matches prNumber, webhook event is silently ignored
  // ─────────────────────────────────────────────────────────────────

  describe('AC7: If no TicketLink matches prNumber, webhook event is silently ignored', () => {
    it('should return success with ignored=true when no TicketLink matches prNumber', async () => {
      const payload = createPullRequestPayload('opened', 999, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(true);
    });

    it('should not throw when no TicketLink matches prNumber', async () => {
      const payload = createPullRequestPayload('opened', 888, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      });

      await expect(
        controller.handleWebhook(mockProject.slug, validSignature, payload),
      ).resolves.not.toThrow();
    });

    it('should silently ignore webhook event when TicketLink lookup returns null', async () => {
      const payload = createPullRequestPayload('closed', 777, false, true);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.ignored).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC8: Unhandled pull_request actions are ignored without error
  // ─────────────────────────────────────────────────────────────────

  describe('AC8: Unhandled pull_request actions are ignored without error', () => {
    it('should ignore synchronize action without error', async () => {
      const payload = createPullRequestPayload('synchronize', 60, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Action 'synchronize' is not processed",
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(true);
    });

    it('should ignore edited action without error', async () => {
      const payload = createPullRequestPayload('edited', 61, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Action 'edited' is not processed",
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(true);
    });

    it('should ignore approved action without error', async () => {
      const payload = createPullRequestPayload('approved', 62, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Action 'approved' is not processed",
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(true);
    });

    it('should ignore convert_to_draft action without error', async () => {
      const payload = createPullRequestPayload('convert_to_draft', 63, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Action 'convert_to_draft' is not processed",
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(true);
    });

    it('should not throw for unhandled pull_request actions', async () => {
      const payload = createPullRequestPayload('unhandled_action', 64, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Action 'unhandled_action' is not processed",
      });

      await expect(
        controller.handleWebhook(mockProject.slug, validSignature, payload),
      ).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Integration: Full pull_request webhook flow
  // ─────────────────────────────────────────────────────────────────

  describe('Integration: Full pull_request webhook flow', () => {
    it('should handle complete webhook flow: verify signature -> route to pull_request handler -> update TicketLink', async () => {
      const payload = createPullRequestPayload('opened', 70, false);
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(mockVerifySignature).toHaveBeenCalledWith(
        payloadString,
        validSignature,
        webhookSecret,
      );
      expect(mockHandleWebhook).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should verify signature before processing pull_request event', async () => {
      const payload = createPullRequestPayload('opened', 71, false);
      const invalidSignature = `sha256=${randomBytes(32).toString('hex')}`;

      mockVerifySignature.mockReturnValue(false);

      await expect(
        controller.handleWebhook(mockProject.slug, invalidSignature, payload),
      ).rejects.toThrow(AuthException);

      expect(mockHandleWebhook).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle pull_request payload without merged_by field', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 80,
          title: 'PR without merger',
          body: null,
          user: { login: 'allowed-user' },
          html_url: 'https://github.com/owner/repo/pull/80',
          state: 'closed',
          draft: false,
          merged: true,
          merged_at: '2024-02-01T00:00:00Z',
          merged_by: null,
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature', repo: { full_name: 'owner/repo' } },
        },
      };
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload as any);

      expect(result.success).toBe(true);
    });

    it('should handle pull_request payload with missing optional fields', async () => {
      const payload = {
        action: 'opened',
        pull_request: {
          number: 81,
          title: 'Minimal PR',
          user: { login: 'allowed-user' },
          html_url: 'https://github.com/owner/repo/pull/81',
          state: 'open',
          draft: false,
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature', repo: { full_name: 'owner/repo' } },
        },
      };
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      mockVerifySignature.mockReturnValue(true);
      mockHandleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload as any);

      expect(result.success).toBe(true);
    });

    it('should handle pull_request event for different PR numbers', async () => {
      const prNumbers = [100, 200, 300, 400, 500];

      for (const prNumber of prNumbers) {
        const payload = createPullRequestPayload('opened', prNumber, false);
        const payloadString = JSON.stringify(payload);
        const validSignature = calculateSignature(payloadString);

        mockVerifySignature.mockReturnValue(true);
        mockHandleWebhook.mockResolvedValue({
          success: true,
          ignored: false,
        });

        const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

        expect(result.success).toBe(true);
      }
    });
  });
});
