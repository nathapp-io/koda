import { Test, TestingModule } from '@nestjs/testing';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto } from './ci-webhook.dto';
import { createHmac } from 'node:crypto';

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

    it('should return JsonResponse with success result', async () => {
      const expectedResult = {
        success: true,
        ticketRef: 'KODA-1',
        message: 'Created ticket for CI failure: AuthService.validateToken',
      };

      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);

      const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(validPayload)).digest('hex')}`;
      const result = await controller.handleCiWebhook('koda', validPayload, signature);

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

      const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(validPayload)).digest('hex')}`;
      await controller.handleCiWebhook('my-project', validPayload, signature);

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

      const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(validPayload)).digest('hex')}`;
      await controller.handleCiWebhook('koda', validPayload, signature);

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

      const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(successPayload)).digest('hex')}`;
      const result = await controller.handleCiWebhook('koda', successPayload, signature);

      expect(result.data).toEqual(expectedResult);
    });

    it('should throw when service throws NotFoundAppException', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockRejectedValue(new Error('Not found'));
      const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(validPayload)).digest('hex')}`;

      await expect(controller.handleCiWebhook('nonexistent', validPayload, signature)).rejects.toThrow('Not found');
    });

    it('should throw when service throws ValidationAppException', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);
      mockCiWebhookService.processCiWebhook.mockRejectedValue(new Error('Validation error'));
      const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(validPayload)).digest('hex')}`;

      await expect(controller.handleCiWebhook('koda', validPayload, signature)).rejects.toThrow('Validation error');
    });

    it('should throw when webhook secret is missing', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(null);

      await expect(controller.handleCiWebhook('koda', validPayload, '')).rejects.toThrow();
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });

    it('should throw when signature is invalid', async () => {
      mockCiWebhookService.getWebhookSecret.mockResolvedValue(secret);

      await expect(controller.handleCiWebhook('koda', validPayload, 'sha256=invalid')).rejects.toThrow();
      expect(mockCiWebhookService.processCiWebhook).not.toHaveBeenCalled();
    });
  });
});
