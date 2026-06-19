import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { VcsPollingService } from './vcs-polling.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { Project, VcsConnection } from '@prisma/client';

jest.mock('./factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../common/utils/encryption.util', () => ({
  decryptToken: jest.fn().mockReturnValue('plain-token'),
}));

import { createVcsProvider } from './factory';

function makeProject(overrides?: Partial<Project>): Project {
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Project;
}

function makeConnection(overrides?: Partial<VcsConnection & { project: Project }>): VcsConnection & { project: Project } {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'polling',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: makeProject(),
    ...overrides,
  } as VcsConnection & { project: Project };
}

function createMockRepo(): jest.Mocked<IVcsRepository> {
  return {
    findPollingConnections: jest.fn().mockResolvedValue([]),
    findVcsConnectionById: jest.fn().mockResolvedValue(null),
    updateVcsConnectionLastSynced: jest.fn().mockResolvedValue(undefined),
    createVcsSyncLog: jest.fn().mockResolvedValue({} as never),
    findProjectById: jest.fn().mockResolvedValue(null),
    findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
    createVcsConnection: jest.fn(),
    updateVcsConnection: jest.fn(),
    deleteVcsConnection: jest.fn(),
    findExistingTicketByExternalId: jest.fn().mockResolvedValue(null),
    createTicketFromIssue: jest.fn(),
    findActiveTicketLinksWithPrs: jest.fn().mockResolvedValue([]),
    findTicketLinkByPrNumber: jest.fn().mockResolvedValue(null),
    updateTicketLinkPrState: jest.fn().mockResolvedValue(undefined),
    updateTicketLinkWithPrState: jest.fn().mockResolvedValue(undefined),
    applyMergedPrTransition: jest.fn().mockResolvedValue(undefined),
    findTicketWithProject: jest.fn().mockResolvedValue(null),
    findPendingOutboxEvents: jest.fn().mockResolvedValue([]),
  } as jest.Mocked<IVcsRepository>;
}

describe('VcsPollingService', () => {
  let service: VcsPollingService;
  let mockRepo: jest.Mocked<IVcsRepository>;
  let mockSchedulerRegistry: jest.Mocked<Pick<SchedulerRegistry, 'addInterval' | 'deleteInterval'>>;
  let mockSyncService: jest.Mocked<Pick<VcsSyncService, 'filterByAllowedAuthors' | 'syncIssue'>>;
  let mockPrSyncService: jest.Mocked<Pick<VcsPrSyncService, 'syncPrStatus'>>;
  let mockConfigService: { get: jest.Mock };

  beforeEach(async () => {
    mockRepo = createMockRepo();

    mockSchedulerRegistry = {
      addInterval: jest.fn(),
      deleteInterval: jest.fn(),
    };

    mockSyncService = {
      filterByAllowedAuthors: jest.fn().mockReturnValue([]),
      syncIssue: jest.fn().mockResolvedValue({ action: 'created', ticketId: 't-1', ticketNumber: 1, ticketTitle: 'Issue' }),
    };

    mockPrSyncService = {
      syncPrStatus: jest.fn().mockResolvedValue({ updated: 0, skipped: 0 }),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key-32-chars-padded'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsPollingService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
        { provide: SchedulerRegistry, useValue: mockSchedulerRegistry },
        { provide: VcsSyncService, useValue: mockSyncService },
        { provide: VcsPrSyncService, useValue: mockPrSyncService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<VcsPollingService>(VcsPollingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('onModuleInit', () => {
    it('should schedule polling for all active polling connections on init', async () => {
      const conn = makeConnection({ syncMode: 'polling', isActive: true });
      mockRepo.findPollingConnections.mockResolvedValue([conn]);

      await service.onModuleInit();

      expect(mockSchedulerRegistry.addInterval).toHaveBeenCalledWith(
        `vcs-polling-${conn.id}`,
        expect.any(Object),
      );
    });

    it('should not schedule connections with syncMode !== polling', async () => {
      const conn = makeConnection({ syncMode: 'webhook', isActive: true });
      mockRepo.findPollingConnections.mockResolvedValue([conn]);

      await service.onModuleInit();

      expect(mockSchedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('should not schedule connections with isActive === false', async () => {
      const conn = makeConnection({ syncMode: 'polling', isActive: false });
      mockRepo.findPollingConnections.mockResolvedValue([conn]);

      await service.onModuleInit();

      expect(mockSchedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('should not call addInterval when there are no polling connections', async () => {
      mockRepo.findPollingConnections.mockResolvedValue([]);

      await service.onModuleInit();

      expect(mockSchedulerRegistry.addInterval).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should unschedule all scheduled connections on destroy', async () => {
      const conn = makeConnection({ syncMode: 'polling', isActive: true });
      mockRepo.findPollingConnections.mockResolvedValue([conn]);

      await service.onModuleInit();
      await service.onModuleDestroy();

      expect(mockSchedulerRegistry.deleteInterval).toHaveBeenCalledWith(`vcs-polling-${conn.id}`);
    });
  });

  describe('schedulePolling', () => {
    it('should register an interval in the scheduler registry', () => {
      jest.useFakeTimers();
      const conn = makeConnection();

      service.schedulePolling(conn);

      expect(mockSchedulerRegistry.addInterval).toHaveBeenCalledWith(
        `vcs-polling-${conn.id}`,
        expect.any(Object),
      );
    });

    it('should remove an existing interval before creating a new one', () => {
      jest.useFakeTimers();
      const conn = makeConnection();

      // First call succeeds; simulate second call where deleteInterval doesn't throw
      service.schedulePolling(conn);
      service.schedulePolling(conn);

      expect(mockSchedulerRegistry.deleteInterval).toHaveBeenCalledWith(`vcs-polling-${conn.id}`);
    });
  });

  describe('unschedulePolling', () => {
    it('should delete the interval from the scheduler', () => {
      service.unschedulePolling('conn-1');

      expect(mockSchedulerRegistry.deleteInterval).toHaveBeenCalledWith('vcs-polling-conn-1');
    });

    it('should not throw when there is no scheduled interval for the connection', () => {
      mockSchedulerRegistry.deleteInterval.mockImplementation(() => {
        throw new Error('Interval not found');
      });

      expect(() => service.unschedulePolling('no-such-conn')).not.toThrow();
    });
  });

  describe('refreshConnectionSchedule', () => {
    it('should schedule polling when connection is active and in polling mode', async () => {
      jest.useFakeTimers();
      const conn = makeConnection({ syncMode: 'polling', isActive: true });
      mockRepo.findVcsConnectionById.mockResolvedValue(conn);

      await service.refreshConnectionSchedule(conn.id);

      expect(mockSchedulerRegistry.addInterval).toHaveBeenCalledWith(
        `vcs-polling-${conn.id}`,
        expect.any(Object),
      );
    });

    it('should not schedule when connection is not in polling mode', async () => {
      const conn = makeConnection({ syncMode: 'webhook', isActive: true });
      mockRepo.findVcsConnectionById.mockResolvedValue(conn);

      await service.refreshConnectionSchedule(conn.id);

      expect(mockSchedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('should not schedule when connection is inactive', async () => {
      const conn = makeConnection({ syncMode: 'polling', isActive: false });
      mockRepo.findVcsConnectionById.mockResolvedValue(conn);

      await service.refreshConnectionSchedule(conn.id);

      expect(mockSchedulerRegistry.addInterval).not.toHaveBeenCalled();
    });

    it('should not schedule when connection is not found', async () => {
      mockRepo.findVcsConnectionById.mockResolvedValue(null);

      await service.refreshConnectionSchedule('missing-id');

      expect(mockSchedulerRegistry.addInterval).not.toHaveBeenCalled();
    });
  });
});
