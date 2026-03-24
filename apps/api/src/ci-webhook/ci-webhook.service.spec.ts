import { Test, TestingModule } from '@nestjs/testing';
import { CiWebhookService } from './ci-webhook.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { CiWebhookPayloadDto } from './ci-webhook.dto';

describe('CiWebhookService', () => {
  let service: CiWebhookService;
  let prismaService: PrismaService<PrismaClient>;

  const mockProject = {
    id: 'proj-123',
    name: 'Koda',
    slug: 'koda',
    key: 'KODA',
    description: 'Dev ticket tracker',
    gitRemoteUrl: 'https://github.com/nathapp-io/koda',
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    ciWebhookToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
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
    assignedToUserId: null,
    assignedToAgentId: null,
    createdByUserId: null,
    createdByAgentId: null,
    gitRefVersion: 'abc123',
    gitRefFile: 'apps/api/src/auth.ts',
    gitRefLine: 42,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
      },
      ticket: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CiWebhookService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<CiWebhookService>(CiWebhookService);
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);
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
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.$transaction.mockResolvedValue(mockTicket);

      const result = await service.processCiWebhook('koda', validPayload);

      expect(result.success).toBe(true);
      expect(result.ticketRef).toBe('KODA-1');
      expect(result.message).toContain('Created ticket for CI failure');
      expect(prismaService.client.$transaction).toHaveBeenCalled();
    });

    it('should throw NotFoundAppException when project not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(service.processCiWebhook('nonexistent', validPayload)).rejects.toThrow();
    });

    it('should throw NotFoundAppException when project is soft-deleted', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue({
        ...mockProject,
        deletedAt: new Date(),
      });

      await expect(service.processCiWebhook('koda', validPayload)).rejects.toThrow();
    });

    it('should ignore pipeline_success events', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);

      const successPayload: CiWebhookPayloadDto = {
        ...validPayload,
        event: 'pipeline_success',
      };

      const result = await service.processCiWebhook('koda', successPayload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('ignored');
      expect(prismaService.client.$transaction).not.toHaveBeenCalled();
    });

    it('should create ticket with correct BUG type and HIGH priority', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticket.create.mockResolvedValue(mockTicket);
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

      await service.processCiWebhook('koda', validPayload);

      // Verify the transaction was called with correct data
      expect(mockPrismaService.client.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'BUG',
            priority: 'HIGH',
            status: 'CREATED',
          }),
        }),
      );
    });

    it('should use first failure for ticket title and git ref', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticket.create.mockResolvedValue(mockTicket);
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

      await service.processCiWebhook('koda', validPayload);

      expect(mockPrismaService.client.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: expect.stringContaining('AuthService.validateToken'),
            gitRefVersion: 'abc123def456',
            gitRefFile: 'apps/api/src/auth/auth.service.ts',
            gitRefLine: 87,
          }),
        }),
      );
    });

    it('should auto-increment ticket number', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue({ number: 5 });
      mockPrismaService.client.ticket.create.mockResolvedValue({ ...mockTicket, number: 6 });
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

      await service.processCiWebhook('koda', validPayload);

      // The transaction creates ticket with number 6 (5 + 1)
      expect(mockPrismaService.client.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            number: 6,
          }),
        }),
      );
    });

    it('should start ticket number at 1 for first ticket', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticket.create.mockResolvedValue({ ...mockTicket, number: 1 });
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

      await service.processCiWebhook('koda', validPayload);

      expect(mockPrismaService.client.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            number: 1,
          }),
        }),
      );
    });

    it('should handle multiple failures', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticket.create.mockResolvedValue(mockTicket);
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

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
      expect(mockPrismaService.client.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: expect.stringContaining('AuthService.validateToken'),
          }),
        }),
      );
    });

    it('should handle failures without file or line', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticket.create.mockResolvedValue({
        ...mockTicket,
        gitRefFile: null,
        gitRefLine: null,
      });
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

      const noLocationPayload: CiWebhookPayloadDto = {
        ...validPayload,
        failures: [{ test: 'Some test without location' }],
      };

      const result = await service.processCiWebhook('koda', noLocationPayload);

      expect(result.success).toBe(true);
      expect(mockPrismaService.client.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gitRefFile: null,
            gitRefLine: null,
          }),
        }),
      );
    });

    it('should build description with pipeline details', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(mockProject);
      mockPrismaService.client.ticket.findFirst.mockResolvedValue(null);
      mockPrismaService.client.ticket.create.mockResolvedValue(mockTicket);
      mockPrismaService.client.$transaction.mockImplementation(async (callback) => {
        return callback({
          ticket: {
            create: mockPrismaService.client.ticket.create,
            findFirst: mockPrismaService.client.ticket.findFirst,
          },
        });
      });

      await service.processCiWebhook('koda', validPayload);

      const createCall = mockPrismaService.client.ticket.create.mock.calls[0][0];
      const description = createCall.data.description;
      expect(description).toContain('12345');
      expect(description).toContain('abc123def456');
      expect(description).toContain('AuthService.validateToken');
    });
  });
});
