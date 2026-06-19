import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsPollingService } from './vcs-polling.service';
import { VcsConnection } from '@prisma/client';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';

jest.mock('../common/utils/encryption.util', () => ({
  encryptToken: jest.fn().mockReturnValue('encrypted-token'),
  decryptToken: jest.fn().mockReturnValue('plain-token'),
}));

jest.mock('./factory', () => ({
  createVcsProvider: jest.fn(),
}));

import { createVcsProvider } from './factory';

function makeConnection(overrides?: Partial<VcsConnection>): VcsConnection {
  return {
    id: 'conn-1',
    projectId: 'proj-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'off',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: null,
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  } as VcsConnection;
}

function createMockRepo(): jest.Mocked<IVcsRepository> {
  return {
    findProjectById: jest.fn().mockResolvedValue({ id: 'proj-1' }),
    findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
    findVcsConnectionById: jest.fn().mockResolvedValue(null),
    findPollingConnections: jest.fn().mockResolvedValue([]),
    createVcsConnection: jest.fn().mockResolvedValue(makeConnection()),
    updateVcsConnection: jest.fn().mockResolvedValue(makeConnection()),
    updateVcsConnectionLastSynced: jest.fn().mockResolvedValue(undefined),
    deleteVcsConnection: jest.fn().mockResolvedValue(undefined),
    createVcsSyncLog: jest.fn().mockResolvedValue({} as never),
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

function createMockPollingService(): jest.Mocked<Pick<VcsPollingService, 'refreshConnectionSchedule' | 'unschedulePolling'>> {
  return {
    refreshConnectionSchedule: jest.fn().mockResolvedValue(undefined),
    unschedulePolling: jest.fn(),
  };
}

describe('VcsConnectionService', () => {
  let service: VcsConnectionService;
  let mockRepo: jest.Mocked<IVcsRepository>;
  let mockPolling: ReturnType<typeof createMockPollingService>;
  let mockConfigService: { get: jest.Mock };

  const ENCRYPTION_KEY = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockRepo = createMockRepo();
    mockPolling = createMockPollingService();
    mockConfigService = { get: jest.fn().mockReturnValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsConnectionService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
        { provide: VcsPollingService, useValue: mockPolling },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<VcsConnectionService>(VcsConnectionService);
  });

  describe('create', () => {
    const dto: CreateVcsConnectionDto = {
      provider: 'github',
      repoOwner: 'owner',
      repoName: 'repo',
      token: 'ghp_abc123',
    } as CreateVcsConnectionDto;

    it('should create a VCS connection and schedule polling', async () => {
      mockRepo.findProjectById.mockResolvedValue({ id: 'proj-1' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);
      mockRepo.createVcsConnection.mockResolvedValue(makeConnection());

      const result = await service.create('proj-1', ENCRYPTION_KEY, dto);

      expect(mockRepo.createVcsConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          provider: 'github',
          repoOwner: 'owner',
          repoName: 'repo',
          encryptedToken: 'encrypted-token',
        }),
      );
      expect(mockPolling.refreshConnectionSchedule).toHaveBeenCalledWith('conn-1');
      expect(result).toBeDefined();
      expect(result.id).toBe('conn-1');
    });

    it('should throw NotFoundAppException when project does not exist', async () => {
      mockRepo.findProjectById.mockResolvedValue(null);

      await expect(service.create('missing-proj', ENCRYPTION_KEY, dto)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('should throw HttpException with CONFLICT when connection already exists', async () => {
      mockRepo.findProjectById.mockResolvedValue({ id: 'proj-1' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());

      await expect(service.create('proj-1', ENCRYPTION_KEY, dto)).rejects.toThrow(
        new HttpException('VCS connection already exists for this project', HttpStatus.CONFLICT),
      );
    });

    it('should parse repoOwner and repoName from repoUrl when provided', async () => {
      mockRepo.findProjectById.mockResolvedValue({ id: 'proj-1' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);
      mockRepo.createVcsConnection.mockResolvedValue(makeConnection({ repoOwner: 'parsed-owner', repoName: 'parsed-repo' }));

      const dtoWithUrl: CreateVcsConnectionDto = {
        provider: 'github',
        token: 'ghp_abc123',
        repoUrl: 'https://github.com/parsed-owner/parsed-repo',
      } as CreateVcsConnectionDto;

      await service.create('proj-1', ENCRYPTION_KEY, dtoWithUrl);

      expect(mockRepo.createVcsConnection).toHaveBeenCalledWith(
        expect.objectContaining({ repoOwner: 'parsed-owner', repoName: 'parsed-repo' }),
      );
    });

    it('should throw ValidationAppException when repoUrl is invalid', async () => {
      mockRepo.findProjectById.mockResolvedValue({ id: 'proj-1' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      // URL that does NOT contain "github.com" as a substring
      const dtoWithBadUrl: CreateVcsConnectionDto = {
        provider: 'github',
        token: 'ghp_abc123',
        repoUrl: 'https://gitlab.com/owner/repo',
      } as CreateVcsConnectionDto;

      await expect(service.create('proj-1', ENCRYPTION_KEY, dtoWithBadUrl)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('should generate a webhookSecret when syncMode is webhook', async () => {
      mockRepo.findProjectById.mockResolvedValue({ id: 'proj-1' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);
      mockRepo.createVcsConnection.mockResolvedValue(makeConnection({ syncMode: 'webhook', webhookSecret: 'some-secret' }));

      const webhookDto: CreateVcsConnectionDto = {
        ...dto,
        syncMode: 'webhook',
      } as CreateVcsConnectionDto;

      await service.create('proj-1', ENCRYPTION_KEY, webhookDto);

      expect(mockRepo.createVcsConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          syncMode: 'webhook',
          webhookSecret: expect.any(String),
        }),
      );
    });
  });

  describe('findByProject', () => {
    it('should return the VCS connection response DTO', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());

      const result = await service.findByProject('proj-1');

      expect(result.id).toBe('conn-1');
      expect(result).not.toHaveProperty('encryptedToken');
    });

    it('should throw NotFoundAppException when no connection exists for the project', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      await expect(service.findByProject('proj-1')).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('update', () => {
    it('should update connection and return updated DTO', async () => {
      const existing = makeConnection({ syncMode: 'off' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(existing);
      const updated = makeConnection({ syncMode: 'polling' });
      mockRepo.updateVcsConnection.mockResolvedValue(updated);

      const dto: UpdateVcsConnectionDto = { syncMode: 'polling' } as UpdateVcsConnectionDto;
      const result = await service.update('proj-1', ENCRYPTION_KEY, dto);

      expect(result.syncMode).toBe('polling');
      expect(mockPolling.refreshConnectionSchedule).toHaveBeenCalledWith(updated.id);
    });

    it('should return existing DTO without calling updateVcsConnection when no fields changed', async () => {
      const existing = makeConnection();
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(existing);

      const emptyDto: UpdateVcsConnectionDto = {} as UpdateVcsConnectionDto;
      await service.update('proj-1', ENCRYPTION_KEY, emptyDto);

      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
    });

    it('should throw NotFoundAppException when no connection exists', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      await expect(service.update('proj-1', ENCRYPTION_KEY, {} as UpdateVcsConnectionDto)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('should clear webhookSecret when syncMode changes away from webhook', async () => {
      const existing = makeConnection({ syncMode: 'webhook', webhookSecret: 'old-secret' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(existing);
      mockRepo.updateVcsConnection.mockResolvedValue(makeConnection({ syncMode: 'polling', webhookSecret: null }));

      await service.update('proj-1', ENCRYPTION_KEY, { syncMode: 'polling' } as UpdateVcsConnectionDto);

      expect(mockRepo.updateVcsConnection).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ webhookSecret: null }),
      );
    });
  });

  describe('delete', () => {
    it('should delete the connection and unschedule polling', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());

      await service.delete('proj-1');

      expect(mockRepo.deleteVcsConnection).toHaveBeenCalledWith('proj-1');
      expect(mockPolling.unschedulePolling).toHaveBeenCalledWith('conn-1');
    });

    it('should throw NotFoundAppException when no connection exists', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      await expect(service.delete('proj-1')).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('testConnection', () => {
    it('should return ok: true with latency when provider test succeeds', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
      const mockProvider = { testConnection: jest.fn().mockResolvedValue({ ok: true }) };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      const result = await service.testConnection('proj-1', ENCRYPTION_KEY);

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return ok: false with error message when provider returns failure', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
      const mockProvider = { testConnection: jest.fn().mockResolvedValue({ ok: false, error: 'Auth failed' }) };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      const result = await service.testConnection('proj-1', ENCRYPTION_KEY);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Auth failed');
    });

    it('should return ok: false with error message when provider throws', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
      const mockProvider = { testConnection: jest.fn().mockRejectedValue(new Error('Network timeout')) };
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      const result = await service.testConnection('proj-1', ENCRYPTION_KEY);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Network timeout');
    });

    it('should throw NotFoundAppException when no connection exists', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      await expect(service.testConnection('proj-1', ENCRYPTION_KEY)).rejects.toThrow(
        NotFoundAppException,
      );
    });
  });

  describe('getFullByProject', () => {
    it('should return the raw VcsConnection including encrypted token', async () => {
      const conn = makeConnection();
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(conn);

      const result = await service.getFullByProject('proj-1');

      expect(result).toBe(conn);
      expect(result.encryptedToken).toBe('enc-token');
    });

    it('should throw NotFoundAppException when no connection exists', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      await expect(service.getFullByProject('proj-1')).rejects.toThrow(NotFoundAppException);
    });
  });
});
