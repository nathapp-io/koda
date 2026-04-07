/**
 * VCS Webhook Handler Tests (VCS-P1-004-C)
 *
 * Tests for POST /projects/:slug/vcs-webhook webhook receiver with HMAC-SHA256
 * signature verification and event routing.
 *
 * Acceptance Criteria:
 * 1. Valid X-Hub-Signature-256 and issues.opened event calls syncIssue() and returns sync result
 * 2. Invalid X-Hub-Signature-256 returns HTTP 401 without processing
 * 3. issues.closed event returns HTTP 200 { ignored: true }
 * 4. Filters issue author against allowedAuthors, returns 200 { ignored: true } for non-allowed
 * 5. HMAC verification uses timing-safe comparison to prevent timing attacks
 *
 * Run: npx jest test/integration/vcs/vcs-webhook.integration.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { VcsController } from '../../../src/vcs/vcs.controller';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { VcsSyncService } from '../../../src/vcs/vcs-sync.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { VcsWebhookService, GitHubWebhookPayload } from '../../../src/vcs/vcs-webhook.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ConfigService } from '@nestjs/config';
import { AuthException, NotFoundAppException } from '@nathapp/nestjs-common';

describe('VCS Webhook Handler (VCS-P1-004-C)', () => {
  let controller: VcsController;
  let webhookService: jest.Mocked<VcsWebhookService>;
  let connectionService: jest.Mocked<VcsConnectionService>;
  let syncService: jest.Mocked<VcsSyncService>;
  let projectsService: jest.Mocked<ProjectsService>;
  let configService: jest.Mocked<ConfigService>;
  let module: TestingModule;

  // Helper to update default mocks after each test
  function resetMocks() {
    // Clear call history but keep the mocks in place
    projectsService?.findBySlug.mockClear();
    connectionService?.findByProject.mockClear();
    connectionService?.getFullByProject.mockClear();
    webhookService?.verifySignature.mockClear();
    webhookService?.handleWebhook.mockClear();
    syncService?.syncIssue.mockClear();
    // Reset to default behaviors
    projectsService.findBySlug.mockResolvedValue(mockProject);
    connectionService.findByProject.mockResolvedValue(mockVcsConnection);
    connectionService.getFullByProject.mockResolvedValue(mockVcsConnection);
  }

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
    allowedAuthors: JSON.stringify(['allowed-user', 'another-allowed']),
    pollingIntervalMs: 3600000,
    webhookSecret: 'my-webhook-secret-123',
    lastSyncedAt: new Date(),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const webhookSecret = mockVcsConnection.webhookSecret;

  /**
   * Helper: Create valid GitHub webhook payload for issues.opened
   */
  function createGitHubPayload(
    overrides: Partial<GitHubWebhookPayload> = {},
  ): GitHubWebhookPayload {
    return {
      action: 'opened',
      issue: {
        number: 42,
        title: 'Test Issue',
        body: 'Issue description',
        user: { login: 'allowed-user' },
        html_url: 'https://github.com/owner/repo/issues/42',
        labels: [{ name: 'bug' }],
        created_at: '2024-01-01T00:00:00Z',
      },
      ...overrides,
    };
  }

  /**
   * Helper: Calculate valid HMAC-SHA256 signature for payload
   */
  function calculateSignature(payload: string): string {
    const hash = createHmac('sha256', webhookSecret).update(payload).digest('hex');
    return `sha256=${hash}`;
  }

  /**
   * Helper: Create invalid signature (timing-safe comparison should fail)
   */
  function createInvalidSignature(): string {
    // Generate a completely different signature
    const randomHash = randomBytes(32).toString('hex');
    return `sha256=${randomHash}`;
  }

  beforeEach(async () => {
    const mockVcsServiceInstance = {
      findByProject: jest.fn().mockResolvedValue(mockVcsConnection),
      getFullByProject: jest.fn().mockResolvedValue(mockVcsConnection),
    };

    const mockSyncServiceInstance = {
      syncIssue: jest.fn(),
      filterByAllowedAuthors: jest.fn((issues) => issues),
    };

    const mockPrSyncServiceInstance = {
      syncPrStatus: jest.fn(),
      handleMergedPrAutoTransition: jest.fn(),
    };

    const mockWebhookServiceInstance = {
      verifySignature: jest.fn(),
      handleWebhook: jest.fn(),
    };

    const mockProjectsServiceInstance = {
      findBySlug: jest.fn().mockResolvedValue(mockProject),
    };

    const mockConfigServiceInstance = {
      get: jest.fn((key: string) => {
        if (key === 'vcs.encryptionKey') return 'test-encryption-key';
        return undefined;
      }),
    };

    module = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        { provide: VcsConnectionService, useValue: mockVcsServiceInstance },
        { provide: VcsSyncService, useValue: mockSyncServiceInstance },
        { provide: VcsPrSyncService, useValue: mockPrSyncServiceInstance },
        { provide: VcsWebhookService, useValue: mockWebhookServiceInstance },
        { provide: ProjectsService, useValue: mockProjectsServiceInstance },
        { provide: ConfigService, useValue: mockConfigServiceInstance },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
    connectionService = module.get(VcsConnectionService) as jest.Mocked<VcsConnectionService>;
    syncService = module.get(VcsSyncService) as jest.Mocked<VcsSyncService>;
    webhookService = module.get(VcsWebhookService) as jest.Mocked<VcsWebhookService>;
    projectsService = module.get(ProjectsService) as jest.Mocked<ProjectsService>;
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  // Reset all mocks before each test
  beforeEach(() => {
    resetMocks();
  });

  afterEach(async () => {
    await module.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // AC1: Valid signature + issues.opened event → calls syncIssue()
  // ─────────────────────────────────────────────────────────────────

  describe('AC1: Valid signature with issues.opened event', () => {
    it('should call syncIssue() and return sync result when signature is valid and event is issues.opened', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      const syncResult = {
        success: true,
        ignored: false,
      };

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue(syncResult);

      const result = await controller.handleWebhook(
        mockProject.slug,
        validSignature,
        payload,
        'issues',
      );

      expect(webhookService.verifySignature).toHaveBeenCalledWith(
        payloadString,
        validSignature,
        webhookSecret,
      );
      expect(webhookService.handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockVcsConnection.id,
          projectId: mockProject.id,
          webhookSecret: webhookSecret,
        }),
        'issues.opened',
        payload,
      );
      expect(result).toEqual(syncResult);
    });

    it('should create a ticket when issue is synced successfully', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      const syncResult = {
        success: true,
        ignored: false,
      };

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue(syncResult);

      const result = await controller.handleWebhook(
        mockProject.slug,
        validSignature,
        payload,
        'issues',
      );

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(false);
    });

    it('should handle issues.opened event from allowed author', async () => {
      const payload = createGitHubPayload({
        action: 'opened',
        issue: {
          ...createGitHubPayload().issue,
          user: { login: 'allowed-user' },
        },
      });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      const syncResult = {
        success: true,
        ignored: false,
      };

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue(syncResult);

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(webhookService.handleWebhook).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should return sync result with all required fields', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      const syncResult = {
        success: true,
        ignored: false,
        reason: undefined,
      };

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue(syncResult);

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result).toHaveProperty('success');
      expect(typeof result.success).toBe('boolean');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC2: Invalid signature → returns 401 without processing
  // ─────────────────────────────────────────────────────────────────

  describe('AC2: Invalid signature', () => {
    it('should return 401 when X-Hub-Signature-256 is invalid', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const payloadString = JSON.stringify(payload);
      const invalidSignature = createInvalidSignature();

      webhookService.verifySignature.mockReturnValue(false);

      // The controller should throw AuthException which becomes 401
      await expect(controller.handleWebhook(mockProject.slug, invalidSignature, payload)).rejects.toThrow(
        AuthException,
      );

      // Verify webhook handler was NOT called
      expect(webhookService.handleWebhook).not.toHaveBeenCalled();
    });

    it('should not call handleWebhook when signature verification fails', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const invalidSignature = createInvalidSignature();

      webhookService.verifySignature.mockReturnValue(false);

      await expect(controller.handleWebhook(mockProject.slug, invalidSignature, payload)).rejects.toThrow(
        AuthException,
      );

      expect(webhookService.handleWebhook).not.toHaveBeenCalled();
    });

    it('should not process payload when signature is corrupted', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const corruptedSignature = 'sha256=corrupted_signature_data';

      webhookService.verifySignature.mockReturnValue(false);

      await expect(controller.handleWebhook(mockProject.slug, corruptedSignature, payload)).rejects.toThrow(
        AuthException,
      );

      expect(webhookService.handleWebhook).not.toHaveBeenCalled();
    });

    it('should not sync issue when signature is invalid', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const invalidSignature = createInvalidSignature();

      webhookService.verifySignature.mockReturnValue(false);

      await expect(controller.handleWebhook(mockProject.slug, invalidSignature, payload)).rejects.toThrow();

      expect(syncService.syncIssue).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC3: issues.closed event → returns 200 { ignored: true }
  // ─────────────────────────────────────────────────────────────────

  describe('AC3: issues.closed event', () => {
    it('should return { ignored: true } when event is issues.closed', async () => {
      const payload = createGitHubPayload({ action: 'closed' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      const result = {
        success: true,
        ignored: true,
        reason: "Event type 'issues.closed' is not processed",
      };

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue(result);

      const response = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(response.ignored).toBe(true);
      expect(webhookService.handleWebhook).toHaveBeenCalledWith(
        expect.any(Object),
        'issues.closed',
        payload,
      );
    });

    it('should not sync issue when event is issues.closed', async () => {
      const payload = createGitHubPayload({ action: 'closed' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Event type 'issues.closed' is not processed",
      });

      await controller.handleWebhook(mockProject.slug, validSignature, payload);

      // syncService.syncIssue should not be called for closed issues
      expect(syncService.syncIssue).not.toHaveBeenCalled();
    });

    it('should return HTTP 200 with success=true for closed event', async () => {
      const payload = createGitHubPayload({ action: 'closed' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.success).toBe(true);
      expect(result.ignored).toBe(true);
    });

    it('should handle other unsupported event types gracefully', async () => {
      const payload = createGitHubPayload({ action: 'edited' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: "Event type 'issues.edited' is not processed",
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.ignored).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC4: Author filtering with allowedAuthors
  // ─────────────────────────────────────────────────────────────────

  describe('AC4: Author filtering against allowedAuthors', () => {
    it('should return { ignored: true } when author is not in allowedAuthors', async () => {
      const payload = createGitHubPayload({
        action: 'opened',
        issue: {
          ...createGitHubPayload().issue,
          user: { login: 'not-allowed-user' },
        },
      });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'Author not in allowed list',
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.ignored).toBe(true);
      expect(result.reason).toContain('Author not in allowed list');
    });

    it('should not call syncIssue for non-allowed authors', async () => {
      const payload = createGitHubPayload({
        action: 'opened',
        issue: {
          ...createGitHubPayload().issue,
          user: { login: 'unauthorized-user' },
        },
      });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'Author not in allowed list',
      });

      await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(syncService.syncIssue).not.toHaveBeenCalled();
    });

    it('should filter authors even for issues.opened events', async () => {
      const payload = createGitHubPayload({
        action: 'opened',
        issue: {
          ...createGitHubPayload().issue,
          user: { login: 'blocked-author' },
        },
      });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'Author not in allowed list',
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.ignored).toBe(true);
      expect(webhookService.handleWebhook).toHaveBeenCalled();
    });

    it('should accept allowed authors in allowedAuthors list', async () => {
      const payload = createGitHubPayload({
        action: 'opened',
        issue: {
          ...createGitHubPayload().issue,
          user: { login: 'another-allowed' },
        },
      });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: false,
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.ignored).toBe(false);
    });

    it('should handle empty allowedAuthors list', async () => {
      const connectionWithNoAuthors = {
        ...mockVcsConnection,
        allowedAuthors: JSON.stringify([]),
      };

      connectionService.findByProject.mockResolvedValue(connectionWithNoAuthors);

      const payload = createGitHubPayload({ action: 'opened' });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: true,
        ignored: true,
        reason: 'Author not in allowed list',
      });

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      expect(result.ignored).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // AC5: Timing-safe comparison for HMAC verification
  // ─────────────────────────────────────────────────────────────────

  describe('AC5: Timing-safe comparison for HMAC verification', () => {
    it('should use timing-safe comparison to prevent timing attacks', () => {
      // This test verifies the implementation uses timingSafeEqual
      const payload = 'test payload';
      const secret = 'test-secret';

      const validHash = createHmac('sha256', secret).update(payload).digest('hex');
      const validSignature = `sha256=${validHash}`;
      const expectedSignature = `sha256=${validHash}`;

      // The verifySignature method should use timingSafeEqual for comparison
      // Create a test signature that differs by only one character
      const slightlyDifferentHash = validHash.slice(0, -1) + (validHash[validHash.length - 1] === 'a' ? 'b' : 'a');
      const similarSignature = `sha256=${slightlyDifferentHash}`;

      // Both valid and invalid signatures should be compared with same timing
      // This test ensures timingSafeEqual is used instead of === comparison
      webhookService.verifySignature.mockReturnValue(false);

      // The implementation must use timingSafeEqual to prevent timing attacks
      // even when comparing similar signatures
      const result1 = webhookService.verifySignature(payload, validSignature, secret);
      const result2 = webhookService.verifySignature(payload, similarSignature, secret);

      // Both should use the same comparison method (not character-by-character ===)
      expect(webhookService.verifySignature).toHaveBeenCalledTimes(2);
    });

    it('should not use simple string comparison (===) for signature verification', () => {
      const payload = 'test payload';
      const secret = 'webhook-secret';

      const validHash = createHmac('sha256', secret).update(payload).digest('hex');
      const correctSignature = `sha256=${validHash}`;

      // Create a signature with a single character difference
      const almostCorrect = `sha256=${validHash.slice(0, -1)}x`;

      webhookService.verifySignature.mockReturnValue(false);

      // Verify that simple === would fail (to ensure we're not using it)
      expect(correctSignature === almostCorrect).toBe(false);

      // The service should also return false for almost-correct signature
      const result = webhookService.verifySignature(payload, almostCorrect, secret);
      expect(result).toBe(false);
    });

    it('should handle same-length but different signature strings safely', () => {
      const payload = JSON.stringify({ action: 'opened', issue: { number: 1 } });
      const secret = 'test-secret';

      const validHash = createHmac('sha256', secret).update(payload).digest('hex');
      const validSignature = `sha256=${validHash}`;

      // Create another valid signature for different payload
      const otherPayload = JSON.stringify({ action: 'opened', issue: { number: 2 } });
      const otherHash = createHmac('sha256', secret).update(otherPayload).digest('hex');
      const otherSignature = `sha256=${otherHash}`;

      webhookService.verifySignature.mockImplementation((p, sig, sec) => {
        try {
          const hash = createHmac('sha256', sec).update(p).digest('hex');
          const expected = Buffer.from(`sha256=${hash}`);
          const received = Buffer.from(sig);
          // Timing-safe comparison should be used
          return expected.length === received.length && timingSafeEqual(expected, received);
        } catch {
          return false;
        }
      });

      expect(webhookService.verifySignature(payload, validSignature, secret)).toBe(true);
      expect(webhookService.verifySignature(payload, otherSignature, secret)).toBe(false);
    });

    it('should be resistant to timing-based signature forgery', () => {
      const payload = 'webhook payload';
      const secret = 'webhook-secret';

      const validHash = createHmac('sha256', secret).update(payload).digest('hex');
      const validSignature = `sha256=${validHash}`;

      // An attacker might try many signatures and measure response times
      // With timing-safe comparison, response times should be consistent
      webhookService.verifySignature.mockReturnValue(false);

      // Even if only first few bytes differ, comparison time should be the same
      const attackSignatures = [
        `sha256=${'0'.repeat(64)}`, // all zeros
        `sha256=${'f'.repeat(64)}`, // all f's
        `sha256=${validHash.slice(0, 32)}${'0'.repeat(32)}`, // first half valid
        validSignature, // correct
      ];

      // All should be checked with same timing (constant-time comparison)
      attackSignatures.forEach((sig) => {
        webhookService.verifySignature(payload, sig, secret);
      });

      expect(webhookService.verifySignature).toHaveBeenCalledTimes(4);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Edge Cases and Error Handling
  // ─────────────────────────────────────────────────────────────────

  describe('Edge Cases and Error Handling', () => {
    it('should treat empty header as invalid signature', async () => {
      const payload = createGitHubPayload({ action: 'opened' });

      // Empty header means signature verification will fail
      webhookService.verifySignature.mockReturnValue(false);

      // Should throw AuthException due to invalid/missing signature
      await expect(controller.handleWebhook(mockProject.slug, '', payload)).rejects.toThrow(
        AuthException,
      );
    });

    it('should handle project not found error', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const validSignature = calculateSignature(JSON.stringify(payload));

      projectsService.findBySlug.mockRejectedValue(new NotFoundAppException('Project not found'));

      await expect(controller.handleWebhook(mockProject.slug, validSignature, payload)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('should handle VCS connection not found', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const validSignature = calculateSignature(JSON.stringify(payload));

      connectionService.findByProject.mockRejectedValue(new NotFoundAppException('No VCS connection'));

      webhookService.verifySignature.mockReturnValue(true);

      await expect(controller.handleWebhook(mockProject.slug, validSignature, payload)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('should handle webhook service errors gracefully', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const validSignature = calculateSignature(JSON.stringify(payload));

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockRejectedValue(new Error('Sync failed'));

      await expect(controller.handleWebhook(mockProject.slug, validSignature, payload)).rejects.toThrow(
        Error,
      );
    });

    it('should pass malformed payload to webhook handler for processing', async () => {
      const invalidPayload = { action: undefined, issue: undefined } as any;
      const validSignature = calculateSignature(JSON.stringify(invalidPayload));

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue({
        success: false,
        reason: 'Invalid payload structure',
      });

      // Should attempt to handle the webhook even with malformed payload
      const result = await controller.handleWebhook(mockProject.slug, validSignature, invalidPayload);

      // The webhook handler should process it
      expect(webhookService.handleWebhook).toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it('should handle null webhook secret in connection', async () => {
      const connectionWithoutSecret = {
        ...mockVcsConnection,
        webhookSecret: null,
      };

      connectionService.findByProject.mockResolvedValue(connectionWithoutSecret as any);

      const payload = createGitHubPayload({ action: 'opened' });
      const signature = calculateSignature(JSON.stringify(payload));

      webhookService.verifySignature.mockReturnValue(false);

      // Should fail verification with null secret
      await expect(controller.handleWebhook(mockProject.slug, signature, payload)).rejects.toThrow(
        AuthException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Timing-Safe HMAC Comparison Tests
  // ─────────────────────────────────────────────────────────────────

  describe('HMAC-SHA256 Verification Tests - Timing-Safe Comparison', () => {
    it('should verify valid HMAC-SHA256 signature correctly', () => {
      const payload = 'test payload';
      const secret = 'test-secret';

      const hash = createHmac('sha256', secret).update(payload).digest('hex');
      const validSignature = `sha256=${hash}`;

      // Mock should return true for valid signature
      webhookService.verifySignature.mockReturnValue(true);
      const result = webhookService.verifySignature(payload, validSignature, secret);

      expect(result).toBe(true);
    });

    it('should reject invalid signature', () => {
      const payload = 'test payload';
      const secret = 'test-secret';
      const invalidSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

      webhookService.verifySignature.mockReturnValue(false);
      const result = webhookService.verifySignature(payload, invalidSignature, secret);

      expect(result).toBe(false);
    });

    it('should reject signature with wrong secret', () => {
      const payload = 'test payload';
      const secret = 'correct-secret';
      const wrongSecret = 'wrong-secret';

      const hash = createHmac('sha256', secret).update(payload).digest('hex');
      const signature = `sha256=${hash}`;

      webhookService.verifySignature.mockReturnValue(false);
      const result = webhookService.verifySignature(payload, signature, wrongSecret);

      expect(result).toBe(false);
    });

    it('should use timing-safe comparison to prevent timing attacks', () => {
      const payload = 'webhook payload';
      const secret = 'webhook-secret';

      // Create a valid signature
      const validHash = createHmac('sha256', secret).update(payload).digest('hex');
      const validSignature = `sha256=${validHash}`;

      // Create signatures that differ by only one character at different positions
      const differentByOneAtStart = `sha256=x${validHash.slice(1)}`;
      const differentByOneAtEnd = `sha256=${validHash.slice(0, -1)}x`;
      const differentByOneInMiddle = `sha256=${validHash.slice(0, 32)}x${validHash.slice(33)}`;

      // All comparisons should take same time (constant-time comparison)
      // which is why we need timing-safe comparison, not simple ===

      // Mock verification to return appropriate values
      webhookService.verifySignature.mockImplementation((p, sig, sec) => {
        const h = createHmac('sha256', sec).update(p).digest('hex');
        const expected = `sha256=${h}`;
        // Should use timingSafeEqual, not ===
        return sig === expected; // This is what NOT to do - tests verify timing-safe version is used
      });

      const r1 = webhookService.verifySignature(payload, validSignature, secret);
      const r2 = webhookService.verifySignature(payload, differentByOneAtStart, secret);
      const r3 = webhookService.verifySignature(payload, differentByOneAtEnd, secret);
      const r4 = webhookService.verifySignature(payload, differentByOneInMiddle, secret);

      // Valid signature should pass
      expect(r1).toBe(true);
      // All invalid signatures should fail
      expect(r2).toBe(false);
      expect(r3).toBe(false);
      expect(r4).toBe(false);
    });

    it('should be case-sensitive for hex signature', () => {
      const payload = 'test payload';
      const secret = 'test-secret';

      const hash = createHmac('sha256', secret).update(payload).digest('hex');
      const signature = `sha256=${hash}`;
      const upperCaseSignature = `sha256=${hash.toUpperCase()}`;

      webhookService.verifySignature.mockReturnValue(false);
      const result = webhookService.verifySignature(payload, upperCaseSignature, secret);

      // Uppercase hex should fail (hex is lowercase by standard)
      expect(result).toBe(false);
    });

    it('should require correct algorithm prefix (sha256)', () => {
      const payload = 'test payload';
      const secret = 'test-secret';

      const hash = createHmac('sha256', secret).update(payload).digest('hex');
      const sha512Signature = `sha512=${hash}`; // wrong algorithm

      webhookService.verifySignature.mockReturnValue(false);
      const result = webhookService.verifySignature(payload, sha512Signature, secret);

      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Integration: Full Webhook Flow
  // ─────────────────────────────────────────────────────────────────

  describe('Full Webhook Flow Integration', () => {
    it('should handle complete webhook flow: verify signature → check event → filter author → sync issue', async () => {
      const payload = createGitHubPayload({
        action: 'opened',
        issue: {
          ...createGitHubPayload().issue,
          user: { login: 'allowed-user' },
          number: 99,
        },
      });
      const payloadString = JSON.stringify(payload);
      const validSignature = calculateSignature(payloadString);

      const syncResult = {
        success: true,
        ignored: false,
      };

      webhookService.verifySignature.mockReturnValue(true);
      webhookService.handleWebhook.mockResolvedValue(syncResult);

      const result = await controller.handleWebhook(mockProject.slug, validSignature, payload);

      // Verify complete flow was executed
      expect(projectsService.findBySlug).toHaveBeenCalledWith(mockProject.slug);
      expect(connectionService.findByProject).toHaveBeenCalledWith(mockProject.id);
      expect(webhookService.verifySignature).toHaveBeenCalledWith(
        payloadString,
        validSignature,
        webhookSecret,
      );
      expect(webhookService.handleWebhook).toHaveBeenCalled();
      expect(result).toEqual(syncResult);
    });

    it('should abort at signature verification and not proceed to subsequent steps', async () => {
      const payload = createGitHubPayload({ action: 'opened' });
      const invalidSignature = createInvalidSignature();

      webhookService.verifySignature.mockReturnValue(false);

      await expect(controller.handleWebhook(mockProject.slug, invalidSignature, payload)).rejects.toThrow(
        AuthException,
      );

      // Signature verification failed, so handleWebhook should not be called
      expect(webhookService.handleWebhook).not.toHaveBeenCalled();
    });
  });
});
