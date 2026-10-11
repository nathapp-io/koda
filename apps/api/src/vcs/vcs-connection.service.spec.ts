import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { VCS_CFG } from '../config/vcs.config';
import { VcsConnectionService } from './vcs-connection.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsPollingService } from './vcs-polling.service';
import type { VcsConnectionDomain } from './domain/vcs.domain';

// TDD type-level compile test: VcsConnectionDomain has no @prisma/client dependency
it('findVcsConnection result has no @prisma/client type — plain object shape', () => {
  const conn: VcsConnectionDomain = {
    id: 'c1', projectId: 'p1', provider: 'github',
    repoOwner: 'acme', repoName: 'repo', encryptedToken: 'tok',
    syncMode: 'polling', allowedAuthors: '[]', pollingIntervalMs: 60000,
    webhookSecret: null, isActive: true, lastSyncedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  expect(conn.id).toBe('c1');
});
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';

vi.mock('../common/utils/encryption.util', () => ({
  encryptToken: vi.fn().mockReturnValue('encrypted-token'),
  decryptToken: vi.fn().mockReturnValue('plain-token'),
}));

vi.mock('./factory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./factory')>()),
  createVcsProvider: vi.fn(),
}));

import { createVcsProvider } from './factory';

function makeConnection(overrides?: Partial<VcsConnectionDomain>): VcsConnectionDomain {
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
  };
}

function createMockRepo(): Mocked<IVcsRepository> {
  return {
    findProjectById: vi.fn().mockResolvedValue({ id: 'proj-1' }),
    findVcsConnectionByProjectId: vi.fn().mockResolvedValue(null),
    findVcsConnectionById: vi.fn().mockResolvedValue(null),
    findVcsConnectionByProjectSlug: vi.fn().mockResolvedValue(null),
    findPollingConnections: vi.fn().mockResolvedValue([]),
    createVcsConnection: vi.fn().mockResolvedValue(makeConnection()),
    updateVcsConnection: vi.fn().mockResolvedValue(makeConnection()),
    updateVcsConnectionLastSynced: vi.fn().mockResolvedValue(undefined),
    deleteVcsConnection: vi.fn().mockResolvedValue(undefined),
    createVcsSyncLog: vi.fn().mockResolvedValue({} as never),
    findExistingTicketByExternalId: vi.fn().mockResolvedValue(null),
    createTicketFromIssue: vi.fn(),
    findActiveTicketLinksWithPrs: vi.fn().mockResolvedValue([]),
    findTicketLinkForConnectionPr: vi.fn().mockResolvedValue(null),
    updateTicketLinkWithPrState: vi.fn().mockResolvedValue('updated'),
    applyMergedPrTransition: vi.fn().mockResolvedValue(undefined),
    findTicketWithProject: vi.fn().mockResolvedValue(null),
    findPendingOutboxEvents: vi.fn().mockResolvedValue([]),
  } as Mocked<IVcsRepository>;
}

function createMockPollingService(): Mocked<Pick<VcsPollingService, 'refreshConnectionSchedule' | 'unschedulePolling'>> {
  return {
    refreshConnectionSchedule: vi.fn().mockResolvedValue(undefined),
    unschedulePolling: vi.fn(),
  };
}

describe('VcsConnectionService', () => {
  let service: VcsConnectionService;
  let mockRepo: Mocked<IVcsRepository>;
  let mockPolling: ReturnType<typeof createMockPollingService>;
  const ENCRYPTION_KEY = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockRepo = createMockRepo();
    mockPolling = createMockPollingService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsConnectionService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
        { provide: VcsPollingService, useValue: mockPolling },
        { provide: VCS_CFG, useValue: { encryptionKey: undefined, defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com' } },
      ],
    }).compile();

    service = module.get<VcsConnectionService>(VcsConnectionService);
  });

  describe('findInboundTarget', () => {
    it('returns the connection with its project from the slug lookup', async () => {
      const target = { ...makeConnection({ syncMode: 'webhook' }), project: { id: 'proj-1', key: 'P', slug: 'p' } };
      mockRepo.findVcsConnectionByProjectSlug.mockResolvedValue(target);

      await expect(service.findInboundTarget('p')).resolves.toBe(target);
      expect(mockRepo.findVcsConnectionByProjectSlug).toHaveBeenCalledWith('p');
    });

    it('returns null instead of throwing NotFound when nothing matches', async () => {
      mockRepo.findVcsConnectionByProjectSlug.mockResolvedValue(null);

      await expect(service.findInboundTarget('missing')).resolves.toBeNull();
    });
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

      // Host-agnostic parsing accepts any host, so an invalid URL is one with
      // fewer than two path segments.
      const dtoWithBadUrl: CreateVcsConnectionDto = {
        provider: 'github',
        token: 'ghp_abc123',
        repoUrl: 'https://github.com/only-owner',
      } as CreateVcsConnectionDto;

      await expect(service.create('proj-1', ENCRYPTION_KEY, dtoWithBadUrl)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('should generate a webhookSecret when created with syncMode off', async () => {
      mockRepo.findProjectById.mockResolvedValue({ id: 'proj-1' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);
      mockRepo.createVcsConnection.mockResolvedValue(makeConnection({ syncMode: 'off', webhookSecret: 'some-secret' }));

      const offModeDto: CreateVcsConnectionDto = {
        ...dto,
        syncMode: 'off',
      } as CreateVcsConnectionDto;

      await service.create('proj-1', ENCRYPTION_KEY, offModeDto);

      expect(mockRepo.createVcsConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          syncMode: 'off',
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

    it('omits webhookSecret and reports webhookSecretConfigured=true when a secret exists', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ webhookSecret: 'super-secret-key' }));

      const result = await service.findByProject('proj-1');

      expect(result).not.toHaveProperty('webhookSecret');
      expect(result).toHaveProperty('webhookSecretConfigured', true);
    });

    it('reports webhookSecretConfigured=false when no secret is set', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ webhookSecret: null }));

      const result = await service.findByProject('proj-1');

      expect(result).not.toHaveProperty('webhookSecret');
      expect(result).toHaveProperty('webhookSecretConfigured', false);
    });

    it('throws NotFoundAppException when no connection exists for the project', async () => {
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

    it('should retain webhookSecret when syncMode changes away from webhook', async () => {
      const existing = makeConnection({ syncMode: 'webhook', webhookSecret: 'old-secret' });
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(existing);
      mockRepo.updateVcsConnection.mockResolvedValue(makeConnection({ syncMode: 'polling', webhookSecret: 'old-secret' }));

      await service.update('proj-1', ENCRYPTION_KEY, { syncMode: 'polling' } as UpdateVcsConnectionDto);

      expect(mockRepo.updateVcsConnection).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ syncMode: 'polling' }),
      );
      expect(mockRepo.updateVcsConnection.mock.calls[0][1]).not.toHaveProperty('webhookSecret');
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
      const mockProvider = { testConnection: vi.fn().mockResolvedValue({ ok: true }) };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      const result = await service.testConnection('proj-1', ENCRYPTION_KEY);

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return ok: false with error message when provider returns failure', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
      const mockProvider = { testConnection: vi.fn().mockResolvedValue({ ok: false, error: 'Auth failed' }) };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

      const result = await service.testConnection('proj-1', ENCRYPTION_KEY);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Auth failed');
    });

    it('should return ok: false with error message when provider throws', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
      const mockProvider = { testConnection: vi.fn().mockRejectedValue(new Error('Network timeout')) };
      (createVcsProvider as Mock).mockReturnValue(mockProvider);

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
