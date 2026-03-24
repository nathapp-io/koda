import { Test, TestingModule } from '@nestjs/testing';
import { CiWebhookController } from './ci-webhook.controller';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto } from './ci-webhook.dto';

describe('CiWebhookController', () => {
  let controller: CiWebhookController;

  const mockCiWebhookService = {
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

      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);

      const result = await controller.handleCiWebhook('koda', validPayload);

      expect(result).toHaveProperty('data');
      expect(result.data).toEqual(expectedResult);
      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith('koda', validPayload);
    });

    it('should pass project slug to service', async () => {
      mockCiWebhookService.processCiWebhook.mockResolvedValue({
        success: true,
        message: 'ignored',
      });

      await controller.handleCiWebhook('my-project', validPayload);

      expect(mockCiWebhookService.processCiWebhook).toHaveBeenCalledWith(
        'my-project',
        validPayload,
      );
    });

    it('should pass full payload to service', async () => {
      mockCiWebhookService.processCiWebhook.mockResolvedValue({
        success: true,
        message: 'Created ticket',
      });

      await controller.handleCiWebhook('koda', validPayload);

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

      mockCiWebhookService.processCiWebhook.mockResolvedValue(expectedResult);

      const result = await controller.handleCiWebhook('koda', successPayload);

      expect(result.data).toEqual(expectedResult);
    });

    it('should throw when service throws NotFoundAppException', async () => {
      mockCiWebhookService.processCiWebhook.mockRejectedValue(new Error('Not found'));

      await expect(controller.handleCiWebhook('nonexistent', validPayload)).rejects.toThrow('Not found');
    });

    it('should throw when service throws ValidationAppException', async () => {
      mockCiWebhookService.processCiWebhook.mockRejectedValue(new Error('Validation error'));

      await expect(controller.handleCiWebhook('koda', validPayload)).rejects.toThrow('Validation error');
    });
  });
});
