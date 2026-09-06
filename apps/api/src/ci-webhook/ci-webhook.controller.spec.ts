import { Test, TestingModule } from '@nestjs/testing';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto } from './ci-webhook.dto';
import { createHmac } from 'node:crypto';

function rawRequestOf(body: string): { rawBody: Buffer } {
  return { rawBody: Buffer.from(body) };
}

describe('CiWebhookController', () => {
  let controller: CiWebhookController;

  const mockCiWebhookService = {
    getWebhookSecret: jest.fn(),
    processCiWebhook: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [
        { provide: CiWebhookService, useValue: mockCiWebhookService },
      ],
    }).compile();

    controller = module.get<CiWebhookController>(CiWebhookController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleCiWebhook', () => {
    const secret = 'test-secret';
    const validPayload: CiWebhookPayloadDto = {
      event: 'pipeline_failed',
      pipeline: { id: '12345', url: 'https://github.com/org/repo/actions/runs/12345' },
      commit: { sha: 'abc123def456', message: 'feat: add dark mode' },
      failures: [
        { test: 'AuthService.validateToken', file: 'apps/api/src/auth/auth.service.ts', line: 87 },
      ],
    };

    function sign(rawBody: string): string {
      return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    }

    it('should return JsonResponse with success result', async () => {
      const expectedResult = {
        success: true,
        ticketRef: 'KODA-1',
        message: 'Created ticket for CI failure: AuthService.validateToken',
      };

      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);

      const rawBody = JSON.stringify(validPayload);
      const signature = sign(rawBody);
      const result = await controller.handleCiWebhook(
        'koda',
        validPayload,
        rawRequestOf(rawBody),
        signature,
      );

      expect(result).toHaveProperty('data');
      expect(result.data).toEqual(expectedResult);
      expect(mockCiWebhookService.getWebhookSecret).toHaveBeenCalledWith('koda');
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('should pass project slug to service', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue({
        success: true,
        message: 'ignored',
      });

      const rawBody = JSON.stringify(validPayload);
      const signature = sign(rawBody);
      await controller.handleCiWebhook('my-project', validPayload, rawRequestOf(rawBody), signature);

      expect(mockCiWebhookService.getWebhookSecret).toHaveBeenCalledWith('my-project');
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith(
        'my-project',
        validPayload,
      );
    });

    it('should pass full payload to service', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue({
        success: true,
        message: 'Created ticket',
      });

      const rawBody = JSON.stringify(validPayload);
      const signature = sign(rawBody);
      await controller.handleCiWebhook('koda', validPayload, rawRequestOf(rawBody), signature);

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('should handle pipeline_success events', async () => {
      const successPayload: CiWebhookPayloadDto = {
        ...validPayload,
        event: 'pipeline_success',
      };

      const expectedResult = {
        success: true,
        message: "Event 'pipeline_success' ignored - only 'pipeline_failed' events are processed",
      };

      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);

      const rawBody = JSON.stringify(successPayload);
      const signature = sign(rawBody);
      const result = await controller.handleCiWebhook(
        'koda',
        successPayload,
        rawRequestOf(rawBody),
        signature,
      );

      expect(result.data).toEqual(expectedResult);
    });

    it('should throw when service throws NotFoundAppException', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockRejectedValue(new Error('Not found'));
      const rawBody = JSON.stringify(validPayload);
      const signature = sign(rawBody);

      await expect(
        controller.handleCiWebhook('nonexistent', validPayload, rawRequestOf(rawBody), signature),
      ).rejects.toThrow('Not found');
    });

    it('should throw when service throws ValidationAppException', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockRejectedValue(new Error('Validation error'));
      const rawBody = JSON.stringify(validPayload);
      const signature = sign(rawBody);

      await expect(
        controller.handleCiWebhook('koda', validPayload, rawRequestOf(rawBody), signature),
      ).rejects.toThrow('Validation error');
    });

    it('should throw when webhook secret is missing', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(null);

      await expect(
        controller.handleCiWebhook('koda', validPayload, rawRequestOf('{}'), ''),
      ).rejects.toThrow();
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('should fall back to JSON.stringify(payload) when rawBody is absent (test/Express compatibility)', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue({ success: true, message: 'ok' });

      // Sign over JSON.stringify(validPayload) — the same bytes the controller
      // falls back to when no rawBody is available.
      const fallbackSignature = sign(JSON.stringify(validPayload));

      await controller.handleCiWebhook(
        'koda',
        validPayload,
        {} as { rawBody?: Buffer },
        fallbackSignature,
      );

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('should throw when signature is invalid', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);

      await expect(
        controller.handleCiWebhook(
          'koda',
          validPayload,
          rawRequestOf('{}'),
          'sha256=invalid',
        ),
      ).rejects.toThrow();
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('should verify against raw bytes, not JSON.stringify(parsed) (KODA-02)', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue({ success: true, message: 'ok' });

      // The client sends this exact byte sequence, with this whitespace and ordering.
      const rawBody = '{"event":"pipeline_failed","pipeline":{"id":"1","url":"u"},"commit":{"sha":"abc","message":"m"},"failures":[]}';
      const signature = sign(rawBody);

      const mutatedPayload: CiWebhookPayloadDto = JSON.parse(rawBody);
      // Mutate the parsed object's key ordering (TypeScript preserves insertion order).
      // Even if the server-side JSON.stringify produced a different byte stream,
      // the HMAC must still validate because we verify against rawBody.
      const reordered: Record<string, unknown> = {
        failures: mutatedPayload.failures,
        commit: mutatedPayload.commit,
        pipeline: mutatedPayload.pipeline,
        event: mutatedPayload.event,
      };

      await controller.handleCiWebhook('koda', reordered as unknown as CiWebhookPayloadDto, rawRequestOf(rawBody), signature);

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalled();
    });
  });
});
