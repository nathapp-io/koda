import { Test, TestingModule } from '@nestjs/testing';
import { CiWebhookService } from './ci-webhook.service';
import { PrismaCiWebhookRepository } from './prisma-ci-webhook.repository';
import { CiWebhookPayloadDto } from './ci-webhook.dto';

describe('CiWebhookService', () => {
  let service: CiWebhookService;

  const mockProject = {
    id: 'proj-123',
    key: 'KODA',
    ciWebhookToken: null,
    deletedAt: null,
  };

  const mockTicket = {
    id: 'ticket-123',
    projectId: 'proj-123',
    number: 1,
    type: 'BUG',
    title: 'CI failure: AuthService.validateToken (pipeline #12345)',
    description: 'Some description',
    status: 'CREATED',
    priority: 'HIGH',
    gitRefVersion: 'abc123',
    gitRefFile: 'apps/api/src/auth.ts',
    gitRefLine: 42,
  };

  const mockRepo = {
    findProjectBySlug: jest.fn(),
    createTicket: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CiWebhookService,
        { provide: PrismaCiWebhookRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<CiWebhookService>(CiWebhookService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('processCiWebhook', () => {
    const validPayload: CiWebhookPayloadDto = {
      event: 'pipeline_failed',
      pipeline: { id: '12345', url: 'https://github.com/org/repo/actions/runs/12345' },
      commit: { sha: 'abc123def456', message: 'feat: add dark mode' },
      failures: [
        { test: 'AuthService.validateToken', file: 'apps/api/src/auth/auth.service.ts', line: 87 },
      ],
    };

    it('should create a ticket for pipeline_failed event', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue(mockTicket);

      const result = await service.processCiWebhook('koda', validPayload);

      expect(result.success).toBe(true);
      expect(result.ticketRef).toBe('KODA-1');
      expect(result.message).toContain('Created ticket for CI failure');
      expect(mockRepo.createTicket).toHaveBeenCalled();
    });

    it('should throw NotFoundAppException when project not found', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(null);

      await expect(service.processCiWebhook('nonexistent', validPayload)).rejects.toThrow();
    });

    it('should throw NotFoundAppException when project is soft-deleted', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue({
        ...mockProject,
        deletedAt: new Date(),
      });

      await expect(service.processCiWebhook('koda', validPayload)).rejects.toThrow();
    });

    it('should ignore pipeline_success events', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);

      const successPayload: CiWebhookPayloadDto = {
        ...validPayload,
        event: 'pipeline_success',
      };

      const result = await service.processCiWebhook('koda', successPayload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('ignored');
      expect(mockRepo.createTicket).not.toHaveBeenCalled();
    });

    it('should create ticket with correct BUG type and HIGH priority', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue(mockTicket);

      await service.processCiWebhook('koda', validPayload);

      expect(mockRepo.createTicket).toHaveBeenCalledWith(
        'proj-123',
        expect.objectContaining({
          type: 'BUG',
          priority: 'HIGH',
          status: 'CREATED',
        }),
      );
    });

    it('should use first failure for ticket title and git ref', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue(mockTicket);

      await service.processCiWebhook('koda', validPayload);

      expect(mockRepo.createTicket).toHaveBeenCalledWith(
        'proj-123',
        expect.objectContaining({
          title: expect.stringContaining('AuthService.validateToken'),
          gitRefVersion: 'abc123def456',
          gitRefFile: 'apps/api/src/auth/auth.service.ts',
          gitRefLine: 87,
        }),
      );
    });

    it('should auto-increment ticket number', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue({ ...mockTicket, number: 6 });

      const result = await service.processCiWebhook('koda', validPayload);

      expect(mockRepo.createTicket).toHaveBeenCalled();
      expect(result.ticketRef).toBe('KODA-6');
    });

    it('should start ticket number at 1 for first ticket', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue({ ...mockTicket, number: 1 });

      const result = await service.processCiWebhook('koda', validPayload);

      expect(mockRepo.createTicket).toHaveBeenCalled();
      expect(result.ticketRef).toBe('KODA-1');
    });

    it('should handle multiple failures', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue(mockTicket);

      const multiFailurePayload: CiWebhookPayloadDto = {
        ...validPayload,
        failures: [
          { test: 'AuthService.validateToken', file: 'apps/api/src/auth.ts', line: 87 },
          { test: 'UserService.getUser', file: 'apps/api/src/user.ts', line: 42 },
          { test: 'Database.query', file: 'apps/api/src/db.ts', line: 100 },
        ],
      };

      await service.processCiWebhook('koda', multiFailurePayload);

      // Should still use first failure for title/git ref
      expect(mockRepo.createTicket).toHaveBeenCalledWith(
        'proj-123',
        expect.objectContaining({
          title: expect.stringContaining('AuthService.validateToken'),
        }),
      );
    });

    it('should handle failures without file or line', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue({
        ...mockTicket,
        gitRefFile: null,
        gitRefLine: null,
      });

      const noLocationPayload: CiWebhookPayloadDto = {
        ...validPayload,
        failures: [{ test: 'Some test without location' }],
      };

      const result = await service.processCiWebhook('koda', noLocationPayload);

      expect(result.success).toBe(true);
      expect(mockRepo.createTicket).toHaveBeenCalledWith(
        'proj-123',
        expect.objectContaining({
          gitRefFile: null,
          gitRefLine: null,
        }),
      );
    });

    it('should build description with pipeline details', async () => {
      mockRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockRepo.createTicket.mockResolvedValue(mockTicket);

      await service.processCiWebhook('koda', validPayload);

      const createCall = mockRepo.createTicket.mock.calls[0][1];
      const description = createCall.description;
      expect(description).toContain('12345');
      expect(description).toContain('abc123def456');
      expect(description).toContain('AuthService.validateToken');
    });
  });
});
