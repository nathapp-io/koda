import { Test, TestingModule } from '@nestjs/testing';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { IVcsRepository, TicketLinkData, VCS_REPOSITORY } from './domain/vcs.repository';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { VcsPrStatus } from './types';

jest.mock('./factory', () => ({
  createVcsProvider: jest.fn(),
}));

jest.mock('../common/utils/encryption.util', () => ({
  decryptToken: jest.fn().mockReturnValue('plain-token'),
}));

import { createVcsProvider } from './factory';

function makeProject(overrides?: Partial<{ id: string; key: string }>): { id: string; key: string } {
  return {
    id: 'proj-1',
    key: 'TEST',
    ...overrides,
  };
}

function makeConnection(overrides?: Partial<VcsConnectionDomain>): VcsConnectionDomain {
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
    ...overrides,
  };
}

function makeTicketLink(overrides?: Partial<TicketLinkData>): TicketLinkData {
  return {
    id: 'link-1',
    ticketId: 'ticket-1',
    prNumber: 7,
    prState: 'open',
    url: 'https://github.com/owner/repo/pull/7',
    externalRef: null,
    ticket: {
      id: 'ticket-1',
      status: 'IN_PROGRESS',
      projectId: 'proj-1',
      number: 42,
      externalVcsId: null,
    },
    ...overrides,
  };
}

function makePrStatus(overrides?: Partial<VcsPrStatus>): VcsPrStatus {
  return {
    number: 7,
    state: 'open',
    draft: false,
    merged: false,
    mergedAt: null,
    mergedBy: null,
    mergeSha: null,
    url: 'https://github.com/owner/repo/pull/7',
    title: 'Fix the bug',
    branchName: 'feature/fix',
    ...overrides,
  };
}

function createMockRepo(): jest.Mocked<IVcsRepository> {
  return {
    findActiveTicketLinksWithPrs: jest.fn().mockResolvedValue([]),
    findTicketLinkByPrNumber: jest.fn().mockResolvedValue(null),
    updateTicketLinkPrState: jest.fn().mockResolvedValue(undefined),
    updateTicketLinkWithPrState: jest.fn().mockResolvedValue(undefined),
    applyMergedPrTransition: jest.fn().mockResolvedValue(undefined),
    findTicketWithProject: jest.fn().mockResolvedValue(null),
    findProjectById: jest.fn().mockResolvedValue(null),
    findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
    findVcsConnectionById: jest.fn().mockResolvedValue(null),
    findPollingConnections: jest.fn().mockResolvedValue([]),
    createVcsConnection: jest.fn(),
    updateVcsConnection: jest.fn(),
    updateVcsConnectionLastSynced: jest.fn().mockResolvedValue(undefined),
    deleteVcsConnection: jest.fn().mockResolvedValue(undefined),
    createVcsSyncLog: jest.fn().mockResolvedValue({} as never),
    findExistingTicketByExternalId: jest.fn().mockResolvedValue(null),
    createTicketFromIssue: jest.fn(),
    findPendingOutboxEvents: jest.fn().mockResolvedValue([]),
  } as jest.Mocked<IVcsRepository>;
}

describe('VcsPrSyncService', () => {
  let service: VcsPrSyncService;
  let mockRepo: jest.Mocked<IVcsRepository>;
  let mockProvider: {
    getPullRequestStatus: jest.Mock;
    listPrCommits: jest.Mock;
    fetchIssues: jest.Mock;
    fetchIssue: jest.Mock;
    testConnection: jest.Mock;
  };

  const project = makeProject();
  const connection = makeConnection();
  const encryptionKey = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockRepo = createMockRepo();

    mockProvider = {
      getPullRequestStatus: jest.fn().mockResolvedValue(makePrStatus()),
      listPrCommits: jest.fn().mockResolvedValue([]),
      fetchIssues: jest.fn(),
      fetchIssue: jest.fn(),
      testConnection: jest.fn(),
    };

    (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsPrSyncService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<VcsPrSyncService>(VcsPrSyncService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('syncPrStatus', () => {
    it('should return updated=0 and skipped=0 when there are no active PR ticket links', async () => {
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([]);

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should update prState when it has changed', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(makePrStatus({ state: 'closed', merged: false }));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkPrState).toHaveBeenCalledWith(link.id, 'closed');
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should not update prState when it has not changed', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(makePrStatus({ state: 'open', merged: false }));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkPrState).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
    });

    it('should mark prState as closed when the provider returns NotFoundAppException (PR not found)', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockRejectedValue(new NotFoundAppException({}, 'vcs'));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkPrState).toHaveBeenCalledWith(link.id, 'closed');
      expect(result.updated).toBe(1);
    });

    it('should skip the PR and increment skipped counter on general API error', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockRejectedValue(new Error('API rate limit'));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkPrState).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('should apply merged PR auto-transition when ticket is IN_PROGRESS and PR merges', async () => {
      const link = makeTicketLink({
        prState: 'open',
        ticket: {
          id: 'ticket-1',
          status: 'IN_PROGRESS',
          projectId: 'proj-1',
          number: 42,
          externalVcsId: null,
        },
      });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(
        makePrStatus({ merged: true, mergedBy: 'alice', mergeSha: 'sha123' }),
      );

      await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.applyMergedPrTransition).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'ticket-1' }),
      );
      expect(mockRepo.updateTicketLinkPrState).toHaveBeenCalledWith(link.id, 'merged');
    });

    it('should still update prState to merged even when auto-transition fails', async () => {
      const link = makeTicketLink({
        prState: 'open',
        ticket: {
          id: 'ticket-1',
          status: 'IN_PROGRESS',
          projectId: 'proj-1',
          number: 42,
          externalVcsId: null,
        },
      });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(makePrStatus({ merged: true }));
      mockRepo.applyMergedPrTransition.mockRejectedValue(new Error('DB error'));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkPrState).toHaveBeenCalledWith(link.id, 'merged');
      expect(result.updated).toBe(1);
    });

    it('should map open PR with draft=true to draft prState', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(
        makePrStatus({ state: 'open', draft: true, merged: false }),
      );

      await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkPrState).toHaveBeenCalledWith(link.id, 'draft');
    });

    it('should process remaining links even when one link fails', async () => {
      const link1 = makeTicketLink({ id: 'link-1', prNumber: 7, prState: 'open' });
      const link2 = makeTicketLink({ id: 'link-2', prNumber: 8, prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link1, link2]);
      mockProvider.getPullRequestStatus
        .mockRejectedValueOnce(new Error('API error for PR 7'))
        .mockResolvedValueOnce(makePrStatus({ number: 8, state: 'closed' }));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(1);
      expect(mockRepo.updateTicketLinkPrState).toHaveBeenCalledWith('link-2', 'closed');
    });
  });

  describe('handleMergedPrAutoTransition', () => {
    it('should apply the transition when ticket is IN_PROGRESS', async () => {
      const link = makeTicketLink({
        ticket: { id: 'ticket-1', status: 'IN_PROGRESS', projectId: 'proj-1', number: 42, externalVcsId: null },
      });
      const prStatus = makePrStatus({ merged: true, mergedBy: 'alice', mergeSha: 'abc' });

      await service.handleMergedPrAutoTransition(link, prStatus);

      expect(mockRepo.applyMergedPrTransition).toHaveBeenCalledWith({
        ticketId: 'ticket-1',
        externalRef: link.externalRef,
        prUrl: prStatus.url,
        mergedBy: 'alice',
        mergeSha: 'abc',
      });
    });

    it('should skip transition when ticket is not IN_PROGRESS', async () => {
      const link = makeTicketLink({
        ticket: { id: 'ticket-1', status: 'DONE', projectId: 'proj-1', number: 42, externalVcsId: null },
      });
      const prStatus = makePrStatus({ merged: true });

      await service.handleMergedPrAutoTransition(link, prStatus);

      expect(mockRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });

    it('should skip transition when link has no ticket', async () => {
      const link = makeTicketLink({ ticket: undefined });
      const prStatus = makePrStatus({ merged: true });

      await service.handleMergedPrAutoTransition(link, prStatus);

      expect(mockRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });

    it('should not throw when applyMergedPrTransition fails', async () => {
      const link = makeTicketLink({
        ticket: { id: 'ticket-1', status: 'IN_PROGRESS', projectId: 'proj-1', number: 42, externalVcsId: null },
      });
      const prStatus = makePrStatus({ merged: true });
      mockRepo.applyMergedPrTransition.mockRejectedValue(new Error('DB error'));

      await expect(service.handleMergedPrAutoTransition(link, prStatus)).resolves.not.toThrow();
    });
  });
});
