import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { IVcsRepository, TicketLinkData, VCS_REPOSITORY } from './domain/vcs.repository';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { VcsConnectionDomain } from './domain/vcs.domain';
import { VcsPrStatus } from './types';

vi.mock('./factory', () => ({
  createVcsProvider: vi.fn(),
}));

vi.mock('../common/utils/encryption.util', () => ({
  decryptToken: vi.fn().mockReturnValue('plain-token'),
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

function createMockRepo(): Mocked<IVcsRepository> {
  return {
    findActiveTicketLinksWithPrs: vi.fn().mockResolvedValue([]),
    findTicketLinkForConnectionPr: vi.fn().mockResolvedValue(null),
    updateTicketLinkWithPrState: vi.fn().mockResolvedValue('updated'),
    applyMergedPrTransition: vi.fn().mockResolvedValue(undefined),
    findTicketWithProject: vi.fn().mockResolvedValue(null),
    findProjectById: vi.fn().mockResolvedValue(null),
    findVcsConnectionByProjectId: vi.fn().mockResolvedValue(null),
    findVcsConnectionById: vi.fn().mockResolvedValue(null),
    findVcsConnectionByProjectSlug: vi.fn().mockResolvedValue(null),
    findPollingConnections: vi.fn().mockResolvedValue([]),
    createVcsConnection: vi.fn(),
    updateVcsConnection: vi.fn(),
    updateVcsConnectionLastSynced: vi.fn().mockResolvedValue(undefined),
    deleteVcsConnection: vi.fn().mockResolvedValue(undefined),
    createVcsSyncLog: vi.fn().mockResolvedValue({} as never),
    findExistingTicketByExternalId: vi.fn().mockResolvedValue(null),
    createTicketFromIssue: vi.fn(),
    findPendingOutboxEvents: vi.fn().mockResolvedValue([]),
  } as Mocked<IVcsRepository>;
}

describe('VcsPrSyncService', () => {
  let service: VcsPrSyncService;
  let mockRepo: Mocked<IVcsRepository>;
  let mockProvider: {
    getPullRequestStatus: Mock;
    listPrCommits: Mock;
    fetchIssues: Mock;
    fetchIssue: Mock;
    testConnection: Mock;
  };

  const project = makeProject();
  const connection = makeConnection();
  const encryptionKey = 'test-key-32-chars-exactly-padded!!';

  beforeEach(async () => {
    mockRepo = createMockRepo();

    mockProvider = {
      getPullRequestStatus: vi.fn().mockResolvedValue(makePrStatus()),
      listPrCommits: vi.fn().mockResolvedValue([]),
      fetchIssues: vi.fn(),
      fetchIssue: vi.fn(),
      testConnection: vi.fn(),
    };

    (createVcsProvider as Mock).mockReturnValue(mockProvider);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VcsPrSyncService,
        { provide: VCS_REPOSITORY, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<VcsPrSyncService>(VcsPrSyncService);
  });

  afterEach(() => {
    vi.clearAllMocks();
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

      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith(link.id, 'closed');
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should not update prState when it has not changed', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(makePrStatus({ state: 'open', merged: false }));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
    });

    it('should mark prState as closed when the provider returns NotFoundAppException (PR not found)', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockRejectedValue(new NotFoundAppException({}, 'vcs'));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith(link.id, 'closed');
      expect(result.updated).toBe(1);
    });

    it('should skip the PR and increment skipped counter on general API error', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockRejectedValue(new Error('API rate limit'));

      const result = await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkWithPrState).not.toHaveBeenCalled();
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
      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith(link.id, 'merged');
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

      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith(link.id, 'merged');
      expect(result.updated).toBe(1);
    });

    it('should map open PR with draft=true to draft prState', async () => {
      const link = makeTicketLink({ prState: 'open' });
      mockRepo.findActiveTicketLinksWithPrs.mockResolvedValue([link]);
      mockProvider.getPullRequestStatus.mockResolvedValue(
        makePrStatus({ state: 'open', draft: true, merged: false }),
      );

      await service.syncPrStatus(project, connection, encryptionKey);

      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith(link.id, 'draft');
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
      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith('link-2', 'closed');
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

  describe('applyMergedPr (C9 §3.5, D457)', () => {
    const merged: VcsPrStatus = {
      number: 7, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T00:00:00Z'),
      mergedBy: 'dev', mergeSha: 'abc', url: 'https://github.com/owner/repo/pull/7', title: 'PR',
    };

    it('writes merged first, then transitions an IN_PROGRESS ticket', async () => {
      const link = makeTicketLink();
      await expect(service.applyMergedPr(link, merged)).resolves.toBe('updated');
      expect(mockRepo.updateTicketLinkWithPrState).toHaveBeenCalledWith('link-1', 'merged');
      expect(mockRepo.applyMergedPrTransition).toHaveBeenCalledTimes(1);
      expect(mockRepo.updateTicketLinkWithPrState.mock.invocationCallOrder[0])
        .toBeLessThan(mockRepo.applyMergedPrTransition.mock.invocationCallOrder[0]);
    });

    it.each(['already-merged', 'not-found'] as const)('does not transition when the write returned %s', async (outcome) => {
      mockRepo.updateTicketLinkWithPrState.mockResolvedValueOnce(outcome);
      await expect(service.applyMergedPr(makeTicketLink(), merged)).resolves.toBe(outcome);
      expect(mockRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });

    it('records merged without a transition for a ticket that is not IN_PROGRESS', async () => {
      const link = makeTicketLink({ ticket: { id: 'ticket-1', status: 'CREATED', projectId: 'proj-1', number: 42, externalVcsId: null } });
      await expect(service.applyMergedPr(link, merged)).resolves.toBe('updated');
      expect(mockRepo.applyMergedPrTransition).not.toHaveBeenCalled();
    });
  });
});
