import { Logger } from '@nestjs/common';
import type { Mock } from 'vitest';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { AfterCommitService } from '../../permissions/after-commit.service';
import { ActivityType, TicketStatus } from '../../common/enums';
import { TicketTransitionsService } from './ticket-transitions.service';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';

vi.mock('../../vcs/factory', () => ({ createVcsProvider: vi.fn() }));
vi.mock('../../common/utils/encryption.util', () => ({ decryptToken: vi.fn().mockReturnValue('plain-token') }));

import { createVcsProvider } from '../../vcs/factory';

/**
 * US-006: the VERIFIED auto-PR and the CLOSED auto-index are post-commit effects.
 *
 * The two effects own nothing they could roll back — a PR or an embedding is external — so they must
 * not run inside the transition's transaction, and must not run at all when that transaction is
 * rolled back. `AfterCommitService.defer` answers whether a scope is open: when one is, the task is
 * queued and dropped with a rollback; when none is, it runs immediately, exactly as before.
 */

const PROJECT = { id: 'proj-1', key: 'KODA', autoIndexOnClose: false, deletedAt: null };

const createdTicket = () => ({
  id: 'ticket-1',
  projectId: PROJECT.id,
  number: 7,
  type: 'BUG',
  title: 'Fix login redirect',
  description: 'Login lands on the wrong page',
  status: TicketStatus.CREATED as string,
  deletedAt: null,
});

const verifyFixTicket = () => ({ ...createdTicket(), status: TicketStatus.VERIFY_FIX as string });
const verifiedTicket = () => ({ ...createdTicket(), status: TicketStatus.VERIFIED as string });

const principal = {
  actorType: 'user' as const,
  id: 'user-1',
  name: 'user@example.com',
  email: 'user@example.com',
  role: 'MEMBER' as const,
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
  extra: { sub: 'user-1' },
} satisfies UserPrincipal;

const connection = {
  isActive: true,
  provider: 'github',
  repoOwner: 'acme',
  repoName: 'widgets',
  encryptedToken: 'enc-token',
};

interface BuildOptions {
  ticket?: Record<string, unknown>;
  autoIndexOnClose?: boolean;
  hasPrLink?: Mock;
  indexDocument?: Mock;
  createPullRequest?: Mock;
  findOpenPullRequestByBranch?: Mock;
  /** Review B2: the PR link write, which a case can make fail. */
  createTicketLink?: Mock;
  /** Review B2: the retry path reads the ticket by id. */
  findByTicketId?: Mock;
}

function build(options: BuildOptions = {}) {
  const ticket = options.ticket ?? createdTicket();
  const project = { ...PROJECT, autoIndexOnClose: options.autoIndexOnClose ?? false };

  const repo = {
    findProjectBySlug: vi.fn().mockResolvedValue(project),
    findTicketByRefRaw: vi.fn().mockResolvedValue(ticket),
    updateTicketStatusIf: vi.fn().mockImplementation(async (_id: string, _from: string, to: string) => ({ ...ticket, status: to })),
    createComment: vi.fn().mockResolvedValue({ id: 'comment-1' }),
    createTicketActivity: vi.fn().mockResolvedValue({ id: 'activity-1' }),
    createTicketLink: options.createTicketLink ?? vi.fn().mockResolvedValue({ id: 'link-1' }),
    findTicketById: options.findByTicketId ?? vi.fn().mockResolvedValue(ticket),
    findTicketWithComments: vi.fn().mockResolvedValue({ ...ticket, comments: [], deletedAt: null }),
    hasFleetOwnership: vi.fn().mockResolvedValue(false),
    hasPrLink: options.hasPrLink ?? vi.fn().mockResolvedValue(false),
    // Whole-branch fix B2: the closing transition re-derives the newest VERIFY_FIX actor.
    findLatestStatusChangeActor: vi.fn().mockResolvedValue(null),
  };

  const provider = {
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    findOpenPullRequestByBranch: options.findOpenPullRequestByBranch ?? vi.fn().mockResolvedValue(null),
    createPullRequest: options.createPullRequest
      ?? vi.fn().mockResolvedValue({ number: 42, url: 'https://github.com/acme/widgets/pull/42' }),
  };
  (createVcsProvider as Mock).mockReturnValue(provider);

  const ragService = { indexDocument: options.indexDocument ?? vi.fn().mockResolvedValue('doc-1') };
  const vcsConnectionService = { getFullByProject: vi.fn().mockResolvedValue(connection) };
  const vcsLinkExtractorService = { extractLinksFromPr: vi.fn().mockResolvedValue(undefined) };
  const afterCommit = new AfterCommitService();
  const outboxService = { record: vi.fn().mockResolvedValue(undefined) };

  const service = new TicketTransitionsService(
    repo as never,
    { run: vi.fn((fn: () => Promise<unknown>) => fn()), getClient: vi.fn(), isInTransaction: vi.fn(() => false) } as never,
    { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) } as never,
    mockAuditRecorder as never,
    afterCommit,
    ragService as never,
    undefined,
    vcsConnectionService as never,
    { create: vi.fn() } as never,
    vcsLinkExtractorService as never,
    { encryptionKey: 'k'.repeat(64) } as never,
    undefined,
    outboxService as never,
  );

  return { service, repo, provider, ragService, vcsConnectionService, vcsLinkExtractorService, afterCommit, outboxService };
}

describe('TicketTransitionsService — post-commit effects (US-006)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-1: the PR is created before verify resolves when no scope is open', () => {
    it('calls createPullRequest once before verify resolves', async () => {
      const { service, provider } = build();

      let callsWhenResolved = -1;
      const result = await service.verify('koda', 'KODA-7', 'Verified', principal).then((value) => {
        callsWhenResolved = provider.createPullRequest.mock.calls.length;
        return value;
      });

      expect(result.ticket.status).toBe(TicketStatus.VERIFIED);
      expect(provider.createPullRequest).toHaveBeenCalledTimes(1);
      expect(callsWhenResolved).toBe(1);
    });
  });

  describe('AC-2 & AC-3: a deferred PR follows the enclosing scope', () => {
    it('AC-2: creates no PR when the scope callback throws', async () => {
      const { service, provider, afterCommit } = build();

      await expect(afterCommit.scope(async () => {
        await service.verify('koda', 'KODA-7', 'Verified', principal);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');

      expect(provider.createPullRequest).not.toHaveBeenCalled();
    });

    it('AC-3: creates the PR once, after the scope callback returned', async () => {
      const { service, provider, afterCommit } = build();
      let callbackReturned = false;

      await afterCommit.scope(async () => {
        const result = await service.verify('koda', 'KODA-7', 'Verified', principal);
        expect(result.ticket.status).toBe(TicketStatus.VERIFIED);
        expect(provider.createPullRequest).not.toHaveBeenCalled();
        callbackReturned = true;
      });

      expect(callbackReturned).toBe(true);
      expect(provider.createPullRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-4 & AC-5: the CLOSED index follows the enclosing scope', () => {
    it('AC-4: indexes nothing when the scope callback throws', async () => {
      const { service, ragService, afterCommit } = build({ ticket: verifyFixTicket(), autoIndexOnClose: true });

      await expect(afterCommit.scope(async () => {
        await service.verifyFix('koda', 'KODA-7', 'Approved', true, principal);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');

      expect(ragService.indexDocument).not.toHaveBeenCalled();
    });

    it('AC-5: has indexed the closed ticket once by the time the scope resolves', async () => {
      const { service, ragService, afterCommit } = build({ ticket: verifyFixTicket(), autoIndexOnClose: true });

      await afterCommit.scope(async () => {
        const result = await service.verifyFix('koda', 'KODA-7', 'Approved', true, principal);
        expect(result.ticket.status).toBe(TicketStatus.CLOSED);
        expect(ragService.indexDocument).not.toHaveBeenCalled();
      });

      expect(ragService.indexDocument).toHaveBeenCalledTimes(1);
    });

    it('defers the admin close() call site the same way — both CLOSED paths defer', async () => {
      const { service, ragService, afterCommit } = build({ ticket: verifiedTicket(), autoIndexOnClose: true });

      await expect(afterCommit.scope(async () => {
        const result = await service.close('koda', 'KODA-7', 'Duplicate', principal);
        expect(result.ticket.status).toBe(TicketStatus.CLOSED);
        expect(ragService.indexDocument).not.toHaveBeenCalled();
        throw new Error('rollback');
      })).rejects.toThrow('rollback');

      expect(ragService.indexDocument).not.toHaveBeenCalled();
    });
  });

  describe('AC-6: the immediate CLOSED path does not wait on the embedding call', () => {
    it('resolves CLOSED while indexDocument is still pending', async () => {
      const never = new Promise<string>(() => undefined);
      const { service, ragService } = build({
        ticket: verifyFixTicket(),
        autoIndexOnClose: true,
        indexDocument: vi.fn().mockReturnValue(never),
      });

      const result = await service.verifyFix('koda', 'KODA-7', 'Approved', true, principal);

      expect(result.ticket.status).toBe(TicketStatus.CLOSED);
      expect(ragService.indexDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('US-010: adopt an existing open PR by branch', () => {
    const adoptedPr = {
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      state: 'open',
      draft: false,
      merged: false,
      mergedAt: null,
      mergedBy: null,
      mergeSha: null,
      title: 'Existing change',
    };

    it('AC-1: adopts PR 7 without creating another PR', async () => {
      const { service, provider } = build({ findOpenPullRequestByBranch: vi.fn().mockResolvedValue(adoptedPr) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(provider.createPullRequest).not.toHaveBeenCalled();
    });

    it('AC-2: stores the adopted PR link with its repository reference', async () => {
      const { service, repo } = build({ findOpenPullRequestByBranch: vi.fn().mockResolvedValue(adoptedPr) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(repo.createTicketLink).toHaveBeenCalledTimes(1);
      expect(repo.createTicketLink).toHaveBeenCalledWith(expect.objectContaining({
        url: adoptedPr.url,
        provider: 'github',
        externalRef: 'acme/widgets#7',
        prNumber: 7,
        linkType: 'pr',
      }));
    });

    it.each([
      [true, 'draft'],
      [false, 'open'],
    ] as const)('AC-3: maps draft=%s to prState=%s', async (draft, prState) => {
      const { service, repo } = build({ findOpenPullRequestByBranch: vi.fn().mockResolvedValue({ ...adoptedPr, draft }) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(repo.createTicketLink).toHaveBeenCalledWith(expect.objectContaining({ prState }));
    });

    it('AC-4: extracts links using the ticket branch and adopted PR number', async () => {
      const { service, vcsLinkExtractorService } = build({ findOpenPullRequestByBranch: vi.fn().mockResolvedValue(adoptedPr) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(vcsLinkExtractorService.extractLinksFromPr).toHaveBeenCalledWith(
        PROJECT,
        expect.anything(),
        connection,
        'k'.repeat(64),
        'koda/KODA-7/fix-login-redirect',
        7,
      );
    });

    it('AC-5: does not record VCS_PR_CREATED for an adopted PR', async () => {
      const { service, repo } = build({ findOpenPullRequestByBranch: vi.fn().mockResolvedValue(adoptedPr) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(repo.createTicketActivity).not.toHaveBeenCalledWith(expect.objectContaining({ action: ActivityType.VCS_PR_CREATED }));
    });

    it('AC-6: searches using the generated ticket branch', async () => {
      const findOpenPullRequestByBranch = vi.fn().mockResolvedValue(adoptedPr);
      const { service, provider } = build({ findOpenPullRequestByBranch });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(provider.findOpenPullRequestByBranch).toHaveBeenCalledWith('koda/KODA-7/fix-login-redirect');
    });

    it('AC-7: falls back to creation when lookup resolves null', async () => {
      const { service, provider } = build();

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(provider.createPullRequest).toHaveBeenCalledTimes(1);
    });

    it('AC-8a: lookup rejection does not create a PR', async () => {
      const { service, provider } = build({
        findOpenPullRequestByBranch: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
      });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(provider.createPullRequest).not.toHaveBeenCalled();
    });

    it('AC-8b: lookup rejection does not create a ticket link', async () => {
      const { service, repo } = build({
        findOpenPullRequestByBranch: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
      });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(repo.createTicketLink).not.toHaveBeenCalled();
    });

    it('AC-9: verify resolves despite lookup rejection', async () => {
      const { service } = build({
        findOpenPullRequestByBranch: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
      });

      await expect(service.verify('koda', 'KODA-7', 'Verified', principal)).resolves.toMatchObject({
        ticket: { status: TicketStatus.VERIFIED },
      });
    });

    it('AC-10: lookup rejection logs a warning', async () => {
      const { service } = build({
        findOpenPullRequestByBranch: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
      });
      const warn = vi.spyOn(Logger.prototype, 'warn');
      warn.mockClear();

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Open PR lookup failed'));
    });
  });

  describe('AC-7 to AC-11: an existing PR link suppresses the classic PR', () => {
    it('AC-7: calls createPullRequest zero times', async () => {
      const { service, provider } = build({ hasPrLink: vi.fn().mockResolvedValue(true) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(provider.createPullRequest).not.toHaveBeenCalled();
    });

    it('AC-8: still resolves VERIFIED', async () => {
      const { service } = build({ hasPrLink: vi.fn().mockResolvedValue(true) });

      await expect(service.verify('koda', 'KODA-7', 'Verified', principal))
        .resolves.toMatchObject({ ticket: { status: TicketStatus.VERIFIED } });
    });

    it('AC-9: a failing lookup calls no provider method at all', async () => {
      const { service, provider, repo } = build({ hasPrLink: vi.fn().mockRejectedValue(new Error('db down')) });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(repo.hasPrLink).toHaveBeenCalledWith('ticket-1');
      expect(provider.getDefaultBranch).not.toHaveBeenCalled();
      expect(provider.createPullRequest).not.toHaveBeenCalled();
      expect(repo.createTicketLink).not.toHaveBeenCalled();
    });

    it('AC-10: a failing lookup logs a warning through the class logger', async () => {
      const { service } = build({ hasPrLink: vi.fn().mockRejectedValue(new Error('db down')) });
      const warn = vi.spyOn(Logger.prototype, 'warn');
      warn.mockClear();

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(warn.mock.calls[0]?.[0]).toContain('PR-link lookup failed for ticket ticket-1');
    });

    it('AC-11: a failing lookup still resolves VERIFIED', async () => {
      const { service } = build({ hasPrLink: vi.fn().mockRejectedValue(new Error('db down')) });

      await expect(service.verify('koda', 'KODA-7', 'Verified', principal))
        .resolves.toMatchObject({ ticket: { status: TicketStatus.VERIFIED } });
    });
  });

  describe('AC-12 & AC-13: a failing provider call cannot undo the transition', () => {
    it('AC-12: resolves VERIFIED when createPullRequest rejects', async () => {
      const { service } = build({ createPullRequest: vi.fn().mockRejectedValue(new Error('GitHub API error')) });

      await expect(service.verify('koda', 'KODA-7', 'Verified', principal))
        .resolves.toMatchObject({ ticket: { status: TicketStatus.VERIFIED } });
    });

    it('AC-13: logs a warning when createPullRequest rejects', async () => {
      const { service } = build({ createPullRequest: vi.fn().mockRejectedValue(new Error('GitHub API error')) });
      const warn = vi.spyOn(Logger.prototype, 'warn');
      warn.mockClear();

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(warn.mock.calls[0]?.[0]).toContain('Failed to create PR for ticket KODA-7: GitHub API error');
    });
  });

  /**
   * Review B2: the link write runs after the VERIFIED transition committed, and the workflow has no route back into
   * VERIFIED — so a forge PR that exists with no link is recovered by a durable retry, not by a second verify.
   */
  describe('review B2: a failed link write leaves a durable retry', () => {
    const createdPr = {
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      draft: true,
      merged: false,
      mergedAt: null,
      mergedBy: null,
      mergeSha: null,
      title: 'Fix login redirect',
    };

    const linkFailure = () => vi.fn()
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValue({ id: 'link-1' });

    it('records the retry on the outbox when the link write fails after the PR was created', async () => {
      const { service, provider, outboxService } = build({ createTicketLink: linkFailure() });

      await service.verify('koda', 'KODA-7', 'Verified', principal);

      expect(provider.createPullRequest).toHaveBeenCalledTimes(1);
      expect(outboxService.record).toHaveBeenCalledTimes(1);
      expect(outboxService.record).toHaveBeenCalledWith({
        type: 'ticket_pr_link_retry',
        payload: { projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1' },
        metadata: { projectId: 'proj-1' },
      });
    });

    it('links the same PR on the retry without creating another', async () => {
      const createTicketLink = linkFailure();
      // The verify creates PR 42 (nothing open yet); the retry finds it.
      const findOpenPullRequestByBranch = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(createdPr);
      const { service, repo, provider, outboxService } = build({ createTicketLink, findOpenPullRequestByBranch });

      await service.verify('koda', 'KODA-7', 'Verified', principal);
      const retry = outboxService.record.mock.calls[0]?.[0] as { payload: unknown };

      await expect(service.retryPrLink(retry.payload as never)).resolves.toBe(true);

      expect(provider.createPullRequest).toHaveBeenCalledTimes(1);
      expect(repo.createTicketLink).toHaveBeenCalledTimes(2);
      expect(repo.createTicketLink).toHaveBeenLastCalledWith(expect.objectContaining({
        prNumber: 42, externalRef: 'acme/widgets#42', linkType: 'pr',
      }));
    });

    it('adopts only: a retry with no open PR creates none', async () => {
      const { service, provider } = build();

      await expect(service.retryPrLink({
        projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1',
      })).resolves.toBe(false);

      expect(provider.createPullRequest).not.toHaveBeenCalled();
    });

    it('writes nothing for a ticket that already carries a PR link', async () => {
      const { service, repo } = build({ hasPrLink: vi.fn().mockResolvedValue(true) });

      await expect(service.retryPrLink({
        projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1',
      })).resolves.toBe(false);

      expect(repo.createTicketLink).not.toHaveBeenCalled();
    });

    it('ignores a retry whose ticket belongs to another project', async () => {
      const { service, provider } = build();

      await expect(service.retryPrLink({
        projectId: 'other-project', projectKey: 'KODA', ticketId: 'ticket-1',
      })).resolves.toBe(false);

      expect(provider.findOpenPullRequestByBranch).not.toHaveBeenCalled();
    });
  });
});
