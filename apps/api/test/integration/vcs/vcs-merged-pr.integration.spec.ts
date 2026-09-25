/**
 * Merged-PR auto-transition integration tests (H6)
 *
 * Verifies the real repository/service path against a real database:
 *
 * 1. When a PR is merged, VcsPrSyncService.syncPrStatus() must persist the
 *    FIX_REPORT comment (authorAgentId: null) and advance the linked ticket
 *    from IN_PROGRESS to VERIFY_FIX. Historically the comment was written with
 *    authorAgentId: 'system', which violated the FK to Agent.id, rolled the
 *    whole transition back, and left the ticket in IN_PROGRESS while prState
 *    was still recorded as 'merged' (so polling never retried).
 *
 * 2. Terminal PR states are final: a stale/out-of-order 'opened' event for a
 *    PR whose TicketLink is already 'merged' must NOT regress prState to
 *    'open' and must NOT produce a second FIX_REPORT comment.
 *
 * Run: cd apps/api && bunx jest test/integration/vcs/vcs-merged-pr --forceExit
 *
 * Bootstrapping follows the resetDb()/DATABASE_URL pattern used by the other
 * DB-backed integration suites. The VCS provider factory is the only mocked
 * seam (no network); repository, transaction manager, and Prisma are real.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import * as factory from '../../../src/vcs/factory';
import type { IVcsProvider } from '../../../src/vcs/vcs-provider';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { CommentType, TicketStatus } from '../../../src/common/enums';
import { encryptToken } from '../../../src/common/utils/encryption.util';
import type { VcsConnectionDomain } from '../../../src/vcs/domain/vcs.domain';
import type { VcsPrStatus } from '../../../src/vcs/types';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex key for AES-256-GCM
const REPO_URL = 'https://github.com/koda-test/repo';

function makePrStatus(overrides: Partial<VcsPrStatus> = {}): VcsPrStatus {
  return {
    number: 42,
    state: 'open',
    draft: false,
    merged: false,
    mergedAt: null,
    mergedBy: null,
    mergeSha: null,
    url: `${REPO_URL}/pull/42`,
    title: 'Fix the bug',
    ...overrides,
  };
}

describeIntegration('VCS merged-PR auto-transition (H6)', () => {
  jest.setTimeout(20000);
  let prisma: PrismaClient;
  let prismaService: PrismaService<PrismaClient>;
  let repo: PrismaVcsRepository;
  let syncService: VcsPrSyncService;

  let projectId: string;
  let ticketId: string;
  let ticketLinkId: string;
  let connection: VcsConnectionDomain;

  const prUrl = `${REPO_URL}/pull/42`;
  const linkUrl = `${REPO_URL}/pull/42`;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb(DATABASE_URL);

    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;

    // Pass-through transaction manager. PrismaVcsRepository always issues its
    // statements on the ambient PrismaService.client (never the tx client), so
    // on SQLite a real interactive transaction would just hold a write lock and
    // time out against the pool writes. A pass-through is behaviorally
    // equivalent here while keeping the FK enforcement of the real database.
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);
    syncService = new VcsPrSyncService(repo);

    // Seed: project + ticket (IN_PROGRESS) + ticket link with an open PR.
    const project = await prisma.project.create({
      data: { name: 'H6 Project', slug: 'h6-project', key: 'H6' },
    });
    projectId = project.id;

    const ticket = await prisma.ticket.create({
      data: {
        projectId,
        number: 1,
        type: 'BUG',
        title: 'Fix the bug',
        status: TicketStatus.IN_PROGRESS,
        priority: 'HIGH',
      },
    });
    ticketId = ticket.id;

    const link = await prisma.ticketLink.create({
      data: {
        ticketId,
        url: linkUrl,
        provider: 'github',
        externalRef: 'koda-test/repo#42',
        prNumber: 42,
        prState: 'open',
        linkType: 'pr',
      },
    });
    ticketLinkId = link.id;

    connection = {
      id: 'conn-h6',
      projectId,
      provider: 'github',
      repoOwner: 'koda-test',
      repoName: 'repo',
      encryptedToken: encryptToken('fake-token', ENCRYPTION_KEY),
      syncMode: 'polling',
      allowedAuthors: JSON.stringify([]),
      pollingIntervalMs: 60000,
      webhookSecret: null,
      isActive: true,
      lastSyncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (prismaService) {
      await prismaService.onModuleDestroy();
    }
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('persists the FIX_REPORT comment (authorAgentId null) and advances the ticket when the PR merges', async () => {
    const mergedStatus = makePrStatus({
      state: 'closed',
      merged: true,
      mergedAt: new Date(),
      mergedBy: 'alice',
      mergeSha: 'abc123',
    });
    jest.spyOn(factory, 'createVcsProvider').mockReturnValue({
      getPullRequestStatus: jest.fn().mockResolvedValue(mergedStatus),
    } as unknown as IVcsProvider);

    const result = await syncService.syncPrStatus(
      { id: projectId, key: 'H6' },
      connection,
      ENCRYPTION_KEY,
    );

    expect(result.updated).toBe(1);

    // (a) The FIX_REPORT comment row exists with authorAgentId null.
    const comments = await prisma.comment.findMany({
      where: { ticketId, type: CommentType.FIX_REPORT },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].authorAgentId).toBeNull();
    expect(comments[0].authorUserId).toBeNull();
    expect(comments[0].body).toContain(prUrl);

    // (b) The ticket advanced to VERIFY_FIX.
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(ticket?.status).toBe(TicketStatus.VERIFY_FIX);

    // (c) prState was persisted as merged.
    const link = await prisma.ticketLink.findUnique({ where: { id: ticketLinkId } });
    expect(link?.prState).toBe('merged');
  });

  it('does not regress a merged TicketLink when a stale opened event arrives', async () => {
    // State after the previous test: link is 'merged', ticket is VERIFY_FIX.
    // Simulate an out-of-order/stale fetch that still returns the merged link
    // while the provider reports the PR as open (e.g. a delayed cached read).
    const staleOpenStatus = makePrStatus({ state: 'open', merged: false });
    jest.spyOn(factory, 'createVcsProvider').mockReturnValue({
      getPullRequestStatus: jest.fn().mockResolvedValue(staleOpenStatus),
    } as unknown as IVcsProvider);

    const mergedLinkRow = await prisma.ticketLink.findUniqueOrThrow({
      where: { id: ticketLinkId },
      include: {
        ticket: {
          select: { id: true, status: true, projectId: true, number: true, externalVcsId: true },
        },
      },
    });
    expect(mergedLinkRow.prState).toBe('merged');

    const findActiveSpy = jest
      .spyOn(repo, 'findActiveTicketLinksWithPrs')
      .mockResolvedValue([mergedLinkRow as never]);

    const result = await syncService.syncPrStatus(
      { id: projectId, key: 'H6' },
      connection,
      ENCRYPTION_KEY,
    );

    // The terminal state must be respected: no update recorded...
    expect(findActiveSpy).toHaveBeenCalled();
    expect(result.updated).toBe(0);

    // ...prState is still merged...
    const link = await prisma.ticketLink.findUnique({ where: { id: ticketLinkId } });
    expect(link?.prState).toBe('merged');

    // ...and no second FIX_REPORT comment was created.
    const comments = await prisma.comment.findMany({
      where: { ticketId, type: CommentType.FIX_REPORT },
    });
    expect(comments).toHaveLength(1);
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(ticket?.status).toBe(TicketStatus.VERIFY_FIX);
  });

  it('never re-processes a merged link via the normal polling query', async () => {
    // findActiveTicketLinksWithPrs must exclude terminal states, so polling
    // cannot retry (or regress) an already-merged link.
    const openStatus = makePrStatus();
    jest.spyOn(factory, 'createVcsProvider').mockReturnValue({
      getPullRequestStatus: jest.fn().mockResolvedValue(openStatus),
    } as unknown as IVcsProvider);

    const activeLinks = await repo.findActiveTicketLinksWithPrs(projectId);
    expect(activeLinks).toHaveLength(0);

    const result = await syncService.syncPrStatus(
      { id: projectId, key: 'H6' },
      connection,
      ENCRYPTION_KEY,
    );
    expect(result.updated).toBe(0);

    const link = await prisma.ticketLink.findUnique({ where: { id: ticketLinkId } });
    expect(link?.prState).toBe('merged');
    const comments = await prisma.comment.findMany({
      where: { ticketId, type: CommentType.FIX_REPORT },
    });
    expect(comments).toHaveLength(1);
  });
});
