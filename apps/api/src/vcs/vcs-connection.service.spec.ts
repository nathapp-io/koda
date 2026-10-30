import { withCommittedEffects } from '../common/committed-effects';
import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { VCS_CFG } from '../config/vcs.config';
import { VcsConnectionService } from './vcs-connection.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsPollingService } from './vcs-polling.service';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { AfterCommitService } from '../permissions/after-commit.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';

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
    updateVcsConnectionById: vi.fn().mockResolvedValue(makeConnection()),
    updateVcsConnectionLastSynced: vi.fn().mockResolvedValue(undefined),
    deleteVcsConnection: vi.fn().mockResolvedValue(undefined),
    createVcsSyncLog: vi.fn().mockResolvedValue({} as never),
    findExistingTicketByExternalId: vi.fn().mockResolvedValue(null),
    createTicketFromIssue: vi.fn(),
    findActiveTicketLinksWithPrs: vi.fn().mockResolvedValue([]),
    findTicketLinkForConnectionPr: vi.fn().mockResolvedValue(null),
    updateTicketLinkWithPrState: vi.fn().mockResolvedValue({ result: 'updated', previousState: null }),
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

async function expectVcsValidation(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(ValidationAppException);
  expect(error).toMatchObject({ prefix: 'vcs' });
}

describe('VcsConnectionService', () => {
  let service: VcsConnectionService;
  let mockRepo: Mocked<IVcsRepository>;
  let mockPolling: ReturnType<typeof createMockPollingService>;
  let afterCommit: AfterCommitService;
  const ENCRYPTION_KEY = 'test-key-32-chars-exactly-padded!!';

  it('prepares provider testing before settlement, then rejects a changed connection without more HTTP', async () => {
    mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
    const testConnection = vi.fn(async () => ({ ok: true }));
    (createVcsProvider as Mock).mockReturnValue({ testConnection });
    const run = await service.prepareTestConnection('proj-1', ENCRYPTION_KEY);
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(await run()).toMatchObject({ ok: true });
    mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ repoName: 'changed' }));
    await expect(run()).rejects.toBeInstanceOf(ValidationAppException);
    expect(testConnection).toHaveBeenCalledTimes(1);
  });

  it('settles with the provider result when only polling timestamps changed', async () => {
    const tested = makeConnection();
    mockRepo.findVcsConnectionByProjectId
      .mockResolvedValueOnce(tested)
      .mockResolvedValueOnce(makeConnection({
        lastSyncedAt: new Date('2024-01-02T00:00:00Z'),
        updatedAt: new Date('2024-01-02T00:00:00Z'),
      }));
    const testConnection = vi.fn(async () => ({ ok: true }));
    (createVcsProvider as Mock).mockReturnValue({ testConnection });

    const settle = await service.prepareTestConnection('proj-1', ENCRYPTION_KEY);

    await expect(settle()).resolves.toMatchObject({ ok: true });
    expect(testConnection).toHaveBeenCalledOnce();
  });

  it.each([
    ['repoOwner', { repoOwner: 'changed-owner' }],
    ['provider', { provider: 'gitlab' }],
    ['encryptedToken', { encryptedToken: 'changed-token' }],
  ] as const)('rejects settlement when %s changed', async (_field, change) => {
    mockRepo.findVcsConnectionByProjectId
      .mockResolvedValueOnce(makeConnection())
      .mockResolvedValueOnce(makeConnection(change));
    (createVcsProvider as Mock).mockReturnValue({ testConnection: vi.fn().mockResolvedValue({ ok: true }) });

    const settle = await service.prepareTestConnection('proj-1', ENCRYPTION_KEY);

    await expectVcsValidation(settle());
  });

  it('rejects settlement when the connection is gone', async () => {
    mockRepo.findVcsConnectionByProjectId.mockResolvedValueOnce(makeConnection()).mockResolvedValueOnce(null);
    (createVcsProvider as Mock).mockReturnValue({ testConnection: vi.fn().mockResolvedValue({ ok: true }) });

    const settle = await service.prepareTestConnection('proj-1', ENCRYPTION_KEY);

    await expectVcsValidation(settle());
  });

  it('rejects settlement when the connection is replaced by a different row with the same target', async () => {
    mockRepo.findVcsConnectionByProjectId
      .mockResolvedValueOnce(makeConnection())
      .mockResolvedValueOnce(makeConnection({ id: 'replacement-connection' }));
    (createVcsProvider as Mock).mockReturnValue({ testConnection: vi.fn().mockResolvedValue({ ok: true }) });

    const settle = await service.prepareTestConnection('proj-1', ENCRYPTION_KEY);

    await expectVcsValidation(settle());
  });

  it.each(['settlement', 'commit'])('retains polling when the owning %s fails', async () => {
    mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
    await expect(withCommittedEffects(async () => {
      await service.delete('proj-1');
      expect(mockPolling.unschedulePolling).not.toHaveBeenCalled();
      throw new Error('owner failed');
    })).rejects.toThrow('owner failed');
    expect(mockPolling.unschedulePolling).not.toHaveBeenCalled();
  });

  beforeEach(async () => {
    mockRepo = createMockRepo();
    mockPolling = createMockPollingService();
    afterCommit = new AfterCommitService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsConnectionService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
        { provide: VcsPollingService, useValue: mockPolling },
        { provide: VCS_CFG, useValue: { encryptionKey: undefined, defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com' } },
        { provide: AuditRecorder, useValue: mockAuditRecorder },
        { provide: AfterCommitService, useValue: afterCommit },
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

    it('audits the created connection with a secret-free summary', async () => {
      mockAuditRecorder.audited = vi.fn(async (fn: () => Promise<unknown>) => fn()) as typeof mockAuditRecorder.audited;
      mockRepo.createVcsConnection.mockResolvedValue(makeConnection({ syncMode: 'webhook', repoOwner: 'owner', repoName: 'repo' }));

      await service.create('proj-1', ENCRYPTION_KEY, { ...dto, syncMode: 'webhook' } as CreateVcsConnectionDto);

      expect(mockAuditRecorder.audited).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
      const entries = (mockAuditRecorder.audited as Mock).mock.calls[0][1](makeConnection({ syncMode: 'webhook' }));
      expect(entries).toMatchObject({ key: 'vcs.connection.create', resourceType: 'vcs-connection', resourceId: 'conn-1', projectId: 'proj-1', summary: 'github owner/repo, sync webhook' });
      expect(JSON.stringify(entries)).not.toContain('webhookSecret');
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

    it('AC-10: defers the polling refresh to the enclosing scope and runs it at once outside one', async () => {
      const calls: string[] = [];
      mockRepo.createVcsConnection.mockImplementation(async () => {
        calls.push('create');
        return makeConnection();
      });
      mockPolling.refreshConnectionSchedule.mockImplementation(async () => {
        calls.push('refresh');
      });

      await afterCommit.scope(async () => {
        await service.create('proj-1', ENCRYPTION_KEY, dto);
        expect(calls).toEqual(['create']);
      });
      expect(calls).toEqual(['create', 'refresh']);

      calls.length = 0;
      await service.create('proj-1', ENCRYPTION_KEY, dto);
      expect(calls).toEqual(['create', 'refresh']);
      expect(mockPolling.refreshConnectionSchedule).toHaveBeenCalledTimes(2);
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
      (mockAuditRecorder.audited as Mock).mockClear();
      const existing = makeConnection();
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(existing);

      const emptyDto: UpdateVcsConnectionDto = {} as UpdateVcsConnectionDto;
      await service.update('proj-1', ENCRYPTION_KEY, emptyDto);

      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
      expect(mockAuditRecorder.audited).not.toHaveBeenCalled();
    });

    it('should throw NotFoundAppException when no connection exists', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(null);

      await expect(service.update('proj-1', ENCRYPTION_KEY, {} as UpdateVcsConnectionDto)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('AC-15: defers the polling refresh to the enclosing scope and survives its failure', async () => {
      const calls: string[] = [];
      const warn = vi.mocked(Logger.prototype.warn);
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ webhookSecret: null }));
      mockRepo.updateVcsConnection.mockImplementation(async () => {
        calls.push('update');
        return makeConnection({ syncMode: 'webhook', webhookSecret: null });
      });
      mockPolling.refreshConnectionSchedule.mockImplementation(async () => {
        calls.push('refresh');
      });
      warn.mockClear();

      // Inside a scope the refresh waits for the transaction owner's callback to return.
      const updated = await afterCommit.scope(async () => {
        const inner = await service.update('proj-1', ENCRYPTION_KEY, { syncMode: 'webhook' } as UpdateVcsConnectionDto);
        expect(calls).toEqual(['update']);
        return inner;
      });
      expect(calls).toEqual(['update', 'refresh']);
      expect(updated.webhookSecret).toEqual(expect.any(String));

      // A deferred refresh that fails is a warning: the executed update, and the one-time secret it
      // answers, are already durable.
      calls.length = 0;
      mockPolling.refreshConnectionSchedule.mockRejectedValue(new Error('scheduler down'));
      const answered = await afterCommit.scope(
        async () => service.update('proj-1', ENCRYPTION_KEY, { syncMode: 'webhook' } as UpdateVcsConnectionDto),
      );

      expect(calls).toEqual(['update']);
      expect(answered.syncMode).toBe('webhook');
      expect(answered.webhookSecret).toEqual(expect.any(String));
      expect(warn).toHaveBeenCalledOnce();
    });

    it('AC-15: outside a scope the refresh stays inline and its failure propagates', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection());
      mockPolling.refreshConnectionSchedule.mockRejectedValue(new Error('scheduler down'));

      await expect(
        service.update('proj-1', ENCRYPTION_KEY, { syncMode: 'polling' } as UpdateVcsConnectionDto),
      ).rejects.toThrow('scheduler down');
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

  describe('connection pinning (US-003)', () => {
    const dto = { syncMode: 'polling' } as UpdateVcsConnectionDto;

    it('AC-10: update refuses a connection id that is not the project current connection', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ id: 'c1' }));

      await expect(service.update('p1', ENCRYPTION_KEY, dto, 'c-other')).rejects.toMatchObject({ prefix: 'vcs' });
      await expect(service.update('p1', ENCRYPTION_KEY, dto, 'c-other')).rejects.toThrow(NotFoundAppException);
      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
    });

    it('AC-10: update writes when the pinned connection is the current one, or when nothing is pinned', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ id: 'c1' }));

      await expect(service.update('p1', ENCRYPTION_KEY, dto, 'c1')).resolves.toBeDefined();
      await expect(service.update('p1', ENCRYPTION_KEY, dto)).resolves.toBeDefined();

      expect(mockRepo.updateVcsConnectionById).toHaveBeenCalledExactlyOnceWith('c1', 'p1', expect.objectContaining({ syncMode: 'polling' }));
      expect(mockRepo.updateVcsConnection).toHaveBeenCalledTimes(1);
    });

    it('AC-10: a pinned write that finds the connection replaced answers 404 vcs', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ id: 'c1' }));
      mockRepo.updateVcsConnectionById.mockResolvedValue(null);

      await expect(service.update('p1', ENCRYPTION_KEY, dto, 'c1')).rejects.toMatchObject({ prefix: 'vcs' });
      await expect(service.update('p1', ENCRYPTION_KEY, dto, 'c1')).rejects.toThrow(NotFoundAppException);
      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
    });

    it('AC-11: rotate refuses a connection id that is not the project current connection', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ id: 'c1' }));

      await expect(service.rotateWebhookSecret('p1', 'c-other')).rejects.toMatchObject({ prefix: 'vcs' });
      await expect(service.rotateWebhookSecret('p1', 'c-other')).rejects.toThrow(NotFoundAppException);
      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
    });

    it('AC-11: rotate writes when the pinned connection is the current one', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ id: 'c1' }));

      const rotated = await service.rotateWebhookSecret('p1', 'c1');

      expect(rotated.webhookSecret).toHaveLength(32);
      expect(mockRepo.updateVcsConnectionById)
        .toHaveBeenCalledExactlyOnceWith('c1', 'p1', { webhookSecret: rotated.webhookSecret });
      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
    });

    it('AC-11: a pinned rotation that finds the connection replaced answers 404 vcs', async () => {
      mockRepo.findVcsConnectionByProjectId.mockResolvedValue(makeConnection({ id: 'c1' }));
      mockRepo.updateVcsConnectionById.mockResolvedValue(null);

      await expect(service.rotateWebhookSecret('p1', 'c1')).rejects.toMatchObject({ prefix: 'vcs' });
      await expect(service.rotateWebhookSecret('p1', 'c1')).rejects.toThrow(NotFoundAppException);
      expect(mockRepo.updateVcsConnection).not.toHaveBeenCalled();
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
