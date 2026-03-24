import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

describe('WebhookDispatcherService', () => {
  let service: WebhookDispatcherService;

  const mockPrismaService = {
    client: {
      webhook: {
        findMany: jest.fn(),
      },
    },
  };

  // Mock fetch globally
  let mockFetch: jest.Mock;

  beforeAll(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterAll(() => {
    delete global.fetch;
  });

  beforeEach(async () => {
    mockFetch.mockReset().mockResolvedValue({ ok: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<WebhookDispatcherService>(WebhookDispatcherService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('dispatch', () => {
    it('should call fetch with correct headers including X-Koda-Signature', async () => {
      const projectId = 'project-123';
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/webhook',
        secret: 'test-secret',
        events: JSON.stringify(['STATUS_CHANGE']),
        active: true,
      };

      mockPrismaService.client.webhook.findMany.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { test: 'payload' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Koda-Event': 'STATUS_CHANGE',
          }),
        }),
      );

      // Verify signature header is present and correct
      const call = mockFetch.mock.calls[0];
      const headers = call[1].headers as Record<string, string>;
      expect(headers['X-Koda-Signature']).toMatch(/^sha256=[a-f0-9]+$/);
    });

    it('should skip webhooks where event not in events array', async () => {
      const projectId = 'project-123';
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/webhook',
        secret: 'test-secret',
        events: JSON.stringify(['TICKET_CREATED']), // Does not include STATUS_CHANGE
        active: true,
      };

      mockPrismaService.client.webhook.findMany.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { test: 'payload' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should not throw when fetch rejects (fire-and-forget)', async () => {
      const projectId = 'project-123';
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/webhook',
        secret: 'test-secret',
        events: JSON.stringify(['STATUS_CHANGE']),
        active: true,
      };

      mockFetch.mockRejectedValue(new Error('Network error'));
      mockPrismaService.client.webhook.findMany.mockResolvedValue([webhook]);

      // Should not throw
      await expect(
        service.dispatch(projectId, 'STATUS_CHANGE', { test: 'payload' }),
      ).resolves.not.toThrow();
    });

    it('should compute HMAC-SHA256 signature correctly', async () => {
      const projectId = 'project-123';
      const secret = 'my-secret-key';
      const payload = JSON.stringify({ event: 'STATUS_CHANGE', data: 'test' });
      const webhook = {
        id: 'webhook-1',
        url: 'https://example.com/webhook',
        secret,
        events: JSON.stringify(['STATUS_CHANGE']),
        active: true,
      };

      mockPrismaService.client.webhook.findMany.mockResolvedValue([webhook]);

      await service.dispatch(projectId, 'STATUS_CHANGE', { event: 'STATUS_CHANGE', data: 'test' });

      const call = mockFetch.mock.calls[0];
      const headers = call[1].headers as Record<string, string>;
      const sig = headers['X-Koda-Signature'].replace('sha256=', '');

      // Verify the signature is a valid hex string (64 chars for sha256)
      expect(sig).toMatch(/^[a-f0-9]{64}$/);

      // Manually compute expected signature
      const crypto = await import('crypto');
      const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      expect(sig).toBe(expectedSig);
    });
  });
});
