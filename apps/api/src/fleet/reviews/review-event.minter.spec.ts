import { Logger } from '@nestjs/common';
import { currentContext } from '../../action-context/action-context';
import { currentBookkeepingReason, noteAuditWrite } from '../../action-context/audit-coverage';
import { encryptToken } from '../../common/utils/encryption.util';
import { GitLabRepoCredentials, type GitLabAccess } from '../git-broker/gitlab-repo-credentials';
import type { GitLabTokenKind } from '../git-broker/prisma-gitlab-credential.repository';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { ReviewEventMinter } from './review-event.minter';
import type { FleetReviewEventRecord } from './domain/fleet-review-event.domain';
import type { ReviewThreadInfo } from '../git-broker/github-app-client';

/** The thread `disagreedBy` names: PR 42 of acme/api with alice as a comment author. */
const matchingThread = (over: Partial<ReviewThreadInfo> = {}): ReviewThreadInfo => ({
  repoOwner: 'acme', repoName: 'api', prNumber: 42, authors: ['alice'], ...over,
});

const reviewRow = (disagreedBy: string[]): FleetReviewEventRecord => ({
  id: 'event-1', projectId: 'p1', repoId: 'r1', jobId: 'j1', leaseEpoch: 1, prNumber: 42,
  findingKey: 'f-12345678', threadId: 't1', finding: 'missing guard', reason: 'guarded upstream',
  file: null, line: null, disagreedBy, trusted: true, status: 'pending', skipReason: null,
  approverLogin: null, memoryItemId: null, attempts: 0, createdAt: new Date(0), updatedAt: new Date(0),
});

/** Every event write must run in the bookkeeping context; the assertion is here so it is always made. */
const bookkeeping = () => {
  expect(currentBookkeepingReason()).toBe('fleet.review-event-bookkeeping');
  noteAuditWrite('FleetReviewEvent.update');
};

function eventStubs(row: FleetReviewEventRecord) {
  return {
    claimPending: vi.fn(async () => { expect(currentBookkeepingReason()).toBeUndefined(); return [row]; }),
    markMinted: vi.fn(async () => { bookkeeping(); }), markSkipped: vi.fn(async () => { bookkeeping(); }),
    bumpAttempt: vi.fn(async () => { bookkeeping(); return 1; }),
  };
}

const writerStubs = () => ({
  guard: vi.fn().mockResolvedValue(null),
  mint: vi.fn(async () => ({ status: 'minted' as const, memoryItemId: 'm1' })),
});

const minted = () => ({ token: 'secret', expiresAt: new Date() });

function githubStubs() {
  return {
    mintThreadReadToken: vi.fn(minted), mintReadOnlyToken: vi.fn(minted),
    getRepoRole: vi.fn().mockResolvedValue('write'), getReviewThread: vi.fn().mockResolvedValue(matchingThread()),
    getPullRequest: vi.fn().mockResolvedValue(null),
  };
}

/** What the mint saw, so a case can assert the approval block without depending on call order. */
const recordedApproval = (harness: { writer: ReturnType<typeof writerStubs> }) => {
  let seen: unknown;
  harness.writer.mint.mockImplementation(async () => {
    seen = currentContext()?.approval;
    return { status: 'minted', memoryItemId: 'm1' };
  });
  return () => seen;
};

function setup(logins = ['alice']) {
  const row = reviewRow(logins);
  const events = eventStubs(row);
  // US-006: the fixtures name their forge, because the minter now branches on it.
  const repos = {
    findReviewRepo: vi.fn().mockResolvedValue({
      id: 'r1', projectId: 'p1', owner: 'acme', name: 'api', defaultBranch: 'main',
      provider: 'github', host: 'https://github.com', githubInstallationId: 77n,
    }),
  };
  const github = githubStubs();
  const writer = writerStubs();
  const minter = new ReviewEventMinter(events as never, repos as never, github as never, writer as never);
  return { row, events, repos, github, writer, minter };
}

/** The master key the fake GitLab credential store encrypts with: 32 bytes, hex. */
const ENCRYPTION_KEY = '0f'.repeat(32);

interface GitLabOptions {
  /** The access level each login is granted; a login it does not name has level 0. */
  levels?: Record<string, number>;
  /** What the discussion read answers, or the error it throws. */
  discussion?: { authors: string[] } | null | Error;
  author?: string | null;
  mergeRequestError?: Error;
  /** When set, every access-level read throws it. */
  accessError?: Error;
  /** False models a repo with no credential row. */
  connected?: boolean;
  /** The key the store is configured with; null models a deployment without one. */
  encryptionKey?: string | null;
}

/**
 * US-006: the GitLab harness. The credential store is the *real* one behind a fake credential
 * repository, so every `call` the minter makes resolves a token, runs the request inside it and
 * marks a 401's token invalid — the seam AC-9 has to prove, not a mocked error.
 */
function gitlabSetup(logins = ['alice'], over: GitLabOptions = {}) {
  const key = over.encryptionKey === undefined ? ENCRYPTION_KEY : over.encryptionKey;
  const markInvalid = vi.fn(async (_repoId: string, _kind: GitLabTokenKind, _at: Date) => undefined);
  const credentialRow = over.connected === false ? null : {
    repoId: 'r1', gitlabProjectId: 42,
    encryptedReadToken: encryptToken('glpat-read', ENCRYPTION_KEY), readTokenUserId: 9, readTokenUsername: 'koda-reader',
    readTokenExpiresAt: null, readTokenInvalidAt: null,
    encryptedWriteToken: encryptToken('glpat-write', ENCRYPTION_KEY), writeTokenUserId: 8, writeTokenUsername: 'koda-writer',
    writeTokenIsBot: true, writeTokenExpiresAt: null, writeTokenInvalidAt: null,
  };
  const store = new GitLabRepoCredentials(
    { findByRepoId: vi.fn(async () => credentialRow), upsert: vi.fn(async () => undefined), markInvalid } as never,
    { encryptionKey: key ?? undefined } as never,
  );
  /** The access each `call` handed its request, in call order. */
  const accesses: GitLabAccess[] = [];
  const call = vi.fn(<T>(repo: { id: string; host?: string }, kind: GitLabTokenKind, fn: (access: GitLabAccess) => Promise<T>) =>
    store.call(repo, kind, async (access) => { accesses.push(access); return fn(access); }));

  const gitlab = {
    getMergeRequest: vi.fn(async (_access: GitLabAccess, _iid: number) => {
      if (over.mergeRequestError) throw over.mergeRequestError;
      return over.author === undefined || over.author === null ? null : { author: over.author };
    }),
    getMemberAccessLevel: vi.fn(async (_access: GitLabAccess, login: string) => {
      if (over.accessError) throw over.accessError;
      return over.levels?.[login] ?? 0;
    }),
    getMergeRequestDiscussion: vi.fn(async (_access: GitLabAccess, _iid: number, _discussionId: string) => {
      if (over.discussion instanceof Error) throw over.discussion;
      return over.discussion === undefined ? { authors: [] } : over.discussion;
    }),
  };
  const row = reviewRow(logins);
  const events = eventStubs(row);
  const repos = {
    findReviewRepo: vi.fn().mockResolvedValue({
      id: 'r1', projectId: 'p1', owner: 'group', name: 'app', defaultBranch: 'main',
      provider: 'gitlab', host: 'https://gitlab.com', githubInstallationId: null,
    }),
  };
  const github = githubStubs();
  const writer = writerStubs();
  const gitlabCredentials = { call };
  const minter = new ReviewEventMinter(
    events as never, repos as never, github as never, writer as never,
    gitlabCredentials as never, gitlab as never,
  );
  return { row, events, repos, github, writer, minter, call, accesses, markInvalid, gitlab };
}

describe('ReviewEventMinter', () => {
  it('AC-1: overlapping run resolves without claiming another batch', async () => {
    const s = setup();
    let release!: () => void;
    s.events.claimPending.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const first = s.minter.run();
    await Promise.resolve();
    await s.minter.run();
    expect(s.events.claimPending).toHaveBeenCalledExactlyOnceWith(20);
    release();
    await first;
  });

  it('AC-2: claim failure is logged and run resolves', async () => {
    const s = setup();
    s.events.claimPending.mockRejectedValueOnce(new Error('claim failed'));
    await expect(s.minter.run()).resolves.toBeUndefined();
  });
  it('AC-1/2/3: mints as SYSTEM/review with forge approval and marks the event id', async () => {
    const s = setup();
    s.writer.mint.mockImplementation(async () => {
      expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'review' }, approval: {
        requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice',
      } });
      expect(currentBookkeepingReason()).toBeUndefined();
      return { status: 'minted', memoryItemId: 'm1' };
    });
    await s.minter.run();
    expect(s.events.claimPending).toHaveBeenCalledWith(20);
    expect(s.writer.mint).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', repoId: 'r1', prNumber: 42, findingKey: 'f-12345678', jobId: 'j1', threadId: 't1', finding: 'missing guard', reason: 'guarded upstream', file: undefined, line: undefined });
    expect(s.events.markMinted).toHaveBeenCalledWith('event-1', { memoryItemId: 'm1', approverLogin: 'alice' });
    expect(s.github.mintThreadReadToken).toHaveBeenCalledWith(77n, 'api');
    expect(s.writer.guard.mock.invocationCallOrder[0]).toBeLessThan(s.repos.findReviewRepo.mock.invocationCallOrder[0]);
  });
  it('AC-4: filters bots before role checks', async () => {
    const s = setup(['dependabot[bot]', 'bob']); await s.minter.run();
    expect(s.github.getRepoRole).toHaveBeenCalledExactlyOnceWith('secret', 'acme', 'api', 'bob');
  });
  it('AC-5: bot-only rows skip before any lookup', async () => {
    const s = setup(['dependabot[bot]']); await s.minter.run();
    expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'no-writer');
    expect(s.repos.findReviewRepo).not.toHaveBeenCalled(); expect(s.writer.guard).not.toHaveBeenCalled();
  });
  it('AC-6: checks every non-bot login once and keeps disagreedBy order', async () => {
    const s = setup(['carol', 'alice', 'dave']); s.github.getRepoRole.mockResolvedValueOnce('read').mockResolvedValueOnce('maintain');
    await s.minter.run();
    expect(s.github.getRepoRole.mock.calls.map(c => c[3])).toEqual(['carol', 'alice', 'dave']);
    expect(s.events.markMinted).toHaveBeenCalledWith(s.row.id, { memoryItemId: 'm1', approverLogin: 'alice' });
  });
  it('AC-7: triage is not a writer', async () => {
    const s = setup(['carol']); s.github.getRepoRole.mockResolvedValue('triage'); await s.minter.run();
    expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'no-writer'); expect(s.writer.mint).not.toHaveBeenCalled();
  });
  it('AC-8: a permission failure never mints an unverified login', async () => {
    const s = setup(); s.github.getRepoRole.mockRejectedValue(new Error('outage')); await s.minter.run();
    expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'permission-check-failed'); expect(s.writer.mint).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'retired'])('AC-9: guard %s skips without network', async reason => {
    const s = setup(); s.writer.guard.mockResolvedValue({ status: 'skipped', reason }); await s.minter.run();
    expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, reason); expect(s.github.mintThreadReadToken).not.toHaveBeenCalled();
  });
  it.each([null, { id: 'r1', githubInstallationId: null }])('AC-10: unavailable repo %j skips', async repo => {
    const s = setup(); s.repos.findReviewRepo.mockResolvedValue(repo); await s.minter.run();
    expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'repo-unavailable'); expect(s.github.mintThreadReadToken).not.toHaveBeenCalled();
  });
  it('AC-11: token failure retries and logs without leaking the token', async () => {
    const s = setup(); s.github.mintThreadReadToken.mockRejectedValue(new Error('secret')); vi.mocked(Logger.prototype.warn).mockClear();
    await s.minter.run(); expect(s.events.bumpAttempt).toHaveBeenCalledWith(s.row.id);
    expect(s.events.markSkipped).not.toHaveBeenCalled(); expect(s.writer.mint).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled(); expect(JSON.stringify(vi.mocked(Logger.prototype.warn).mock.calls)).not.toContain('secret');
  });
  it('AC-12: third mint failure is terminal', async () => {
    const s = setup(); s.writer.mint.mockRejectedValue(new Error('outage')); s.events.bumpAttempt.mockResolvedValue(3); await s.minter.run();
    expect(s.events.bumpAttempt).toHaveBeenCalledWith(s.row.id); expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'mint-failed');
  });
  it('AC-13: mint race returns a durable skip', async () => {
    const s = setup(); s.writer.mint.mockResolvedValue({ status: 'skipped', reason: 'retired' } as never); await s.minter.run();
    expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'retired'); expect(s.events.markMinted).not.toHaveBeenCalled();
  });

  describe('US-007 verified approver', () => {
    it('US-007 AC-8: a writer who authored a comment in the matching thread is a verified human approver', async () => {
      const s = setup(); const approval = recordedApproval(s);
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toEqual({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice' });
    });

    it('US-007 AC-9/10: the verified case obtains its token with mintThreadReadToken and never the read-only one', async () => {
      const s = setup(); await s.minter.run();
      expect(s.github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(77n, 'api');
      expect(s.github.mintReadOnlyToken).not.toHaveBeenCalled();
    });

    it('US-007 AC-11: a thread whose authors exclude the writer keeps the mint unverified', async () => {
      const s = setup(); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ authors: ['bob'] }));
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toEqual({ requiredMode: 'human', satisfiedBy: 'none', approverType: 'FORGE_USER', approverId: 'github:alice' });
      expect(s.events.markMinted).toHaveBeenCalledWith(s.row.id, { memoryItemId: 'm1', approverLogin: 'alice' });
    });

    it('US-007 AC-12: a null thread keeps the mint unverified', async () => {
      const s = setup(); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(null);
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toMatchObject({ satisfiedBy: 'none', approverId: 'github:alice' });
    });

    it('US-007 AC-13: a thrown lookup keeps the mint unverified', async () => {
      const s = setup(); const approval = recordedApproval(s);
      s.github.getReviewThread.mockRejectedValue(new Error('outage'));
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toMatchObject({ satisfiedBy: 'none', approverId: 'github:alice' });
      expect(s.events.markMinted).toHaveBeenCalledWith(s.row.id, { memoryItemId: 'm1', approverLogin: 'alice' });
    });

    it.each([
      ['US-007 AC-14: a thread of another PR', matchingThread({ prNumber: 8 })],
      ['US-007 AC-15: a thread of another repository name', matchingThread({ repoName: 'other' })],
    ])('%s keeps the mint unverified', async (_criterion, thread) => {
      const s = setup(); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(thread);
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toMatchObject({ satisfiedBy: 'none', approverId: 'github:alice' });
    });

    it('US-007: a thread of another owner keeps the mint unverified', async () => {
      const s = setup(); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ repoOwner: 'other' }));
      await s.minter.run();
      expect(approval()).toMatchObject({ satisfiedBy: 'none', approverId: 'github:alice' });
    });

    it('US-007 AC-16: the first writer among the thread authors is the approver', async () => {
      const s = setup(['bob', 'alice']); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ authors: ['alice'] }));
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toMatchObject({ satisfiedBy: 'human', approverId: 'github:alice' });
      expect(s.github.getReviewThread).toHaveBeenCalledExactlyOnceWith('secret', 't1');
    });

    it('US-007 AC-17: a login whose case differs still matches the thread author', async () => {
      const s = setup(['Alice']); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ authors: ['alice'] }));
      await s.minter.run();
      expect(s.github.getReviewThread).toHaveBeenCalledExactlyOnceWith('secret', 't1');
      expect(approval()).toMatchObject({ satisfiedBy: 'human', approverId: 'github:Alice' });
    });

    it('US-007 AC-18: readers-only disagreedBy skips no-writer', async () => {
      const s = setup(['bob']); s.github.getRepoRole.mockResolvedValue('read');
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'no-writer');
      expect(s.writer.mint).not.toHaveBeenCalled();
    });

    it('US-007 AC-19: the no-writer event never looks the thread up', async () => {
      const s = setup(['bob']); s.github.getRepoRole.mockResolvedValue('read');
      await s.minter.run();
      expect(s.github.getReviewThread).not.toHaveBeenCalled();
    });

    it('US-007: a thread repository match ignores case', async () => {
      const s = setup(); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ repoOwner: 'Acme', repoName: 'API' }));
      await s.minter.run();
      expect(approval()).toMatchObject({ satisfiedBy: 'human', approverId: 'github:alice' });
    });
  });

  describe('US-006 GitLab review events', () => {
    /** The GitHub client methods a GitLab row must never reach. */
    const GITHUB_METHODS = ['mintThreadReadToken', 'mintReadOnlyToken', 'getRepoRole', 'getReviewThread'] as const;

    it('US-006 AC-3: a Developer writer who authored the discussion is the verified human approver', async () => {
      const s = gitlabSetup(['alice', 'bob'], { levels: { alice: 30, bob: 20 }, discussion: { authors: ['alice'] } });
      const approval = recordedApproval(s);
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toEqual({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'gitlab:alice' });
      expect(s.events.markMinted).toHaveBeenCalledWith(s.row.id, { memoryItemId: 'm1', approverLogin: 'alice' });
    });

    it('US-006 AC-4: every forge read runs in its own read call, and the GitHub client is untouched', async () => {
      const s = gitlabSetup(['alice', 'bob'], { levels: { alice: 30, bob: 20 }, discussion: { authors: ['alice'] } });
      await s.minter.run();
      // One call per forge request: two access-level reads, MR read, and discussion read.
      expect(s.call).toHaveBeenCalledTimes(4);
      expect(s.call.mock.calls.map((c) => c[1])).toEqual(['read', 'read', 'read', 'read']);
      expect(s.call.mock.calls.map((c) => c[0])).toEqual([
        { id: 'r1', host: 'https://gitlab.com' }, { id: 'r1', host: 'https://gitlab.com' },
        { id: 'r1', host: 'https://gitlab.com' }, { id: 'r1', host: 'https://gitlab.com' },
      ]);
      expect(s.accesses).toHaveLength(4);
      expect(new Set(s.accesses).size).toBe(4);
      // Each read is handed the access its own call produced.
      expect(s.gitlab.getMemberAccessLevel).toHaveBeenCalledTimes(2);
      for (const [access, login] of s.gitlab.getMemberAccessLevel.mock.calls) {
        expect(s.accesses).toContain(access);
        expect(access.token).toBe('glpat-read');
        expect(login).toBeDefined();
      }
      const [discussionAccess, iid, discussionId] = s.gitlab.getMergeRequestDiscussion.mock.calls[0];
      expect(s.accesses).toContain(discussionAccess);
      // The discussion read has a call of its own, not one of the access-level reads.
      expect(s.gitlab.getMemberAccessLevel.mock.calls.map((c) => c[0])).not.toContain(discussionAccess);
      expect([iid, discussionId]).toEqual([42, 't1']);
      for (const method of GITHUB_METHODS) expect(s.github[method]).not.toHaveBeenCalled();
    });

    it('US-006 AC-5: a differently-cased discussion author verifies the writer', async () => {
      const s = gitlabSetup(['alice'], { levels: { alice: 30 }, discussion: { authors: ['ALICE'] } });
      const approval = recordedApproval(s);
      await s.minter.run();
      expect(approval()).toMatchObject({ satisfiedBy: 'human', approverId: 'gitlab:alice' });
    });

    it('US-006 AC-6: logins below Developer access skip no-writer without reading the discussion', async () => {
      const s = gitlabSetup(['alice', 'bob'], { levels: { alice: 20, bob: 10 }, discussion: { authors: ['alice'] } });
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'no-writer');
      expect(s.writer.mint).not.toHaveBeenCalled();
      expect(s.gitlab.getMergeRequestDiscussion).not.toHaveBeenCalled();
    });

    it('US-006 AC-7: a discussion that no longer exists keeps the first writer, unverified', async () => {
      const s = gitlabSetup(['bob', 'alice'], { levels: { alice: 30, bob: 30 }, discussion: null });
      const approval = recordedApproval(s);
      await s.minter.run();
      expect(approval()).toEqual({ requiredMode: 'human', satisfiedBy: 'none', approverType: 'FORGE_USER', approverId: 'gitlab:bob' });
      expect(s.events.markMinted).toHaveBeenCalledWith(s.row.id, { memoryItemId: 'm1', approverLogin: 'bob' });
    });

    it('US-006 AC-8: a failed discussion read mints the decision unverified', async () => {
      const s = gitlabSetup(['alice'], { levels: { alice: 30 }, discussion: new Error('outage') });
      const approval = recordedApproval(s);
      await s.minter.run();
      expect(s.writer.mint).toHaveBeenCalledTimes(1);
      expect(approval()).toMatchObject({ satisfiedBy: 'none', approverId: 'gitlab:alice' });
      expect(s.events.markSkipped).not.toHaveBeenCalled();
    });

    it('US-006 AC-9: a refused access-level read skips the row and marks the read token invalid', async () => {
      const s = gitlabSetup(['alice'], { accessError: new RepoCheckException('gitlab_token_invalid') });
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'permission-check-failed');
      expect(s.writer.mint).not.toHaveBeenCalled();
      // The refusal travelled out of `call`, which marked the token the request used.
      expect(s.markInvalid).toHaveBeenCalledExactlyOnceWith('r1', 'read', expect.any(Date));
    });

    it('US-006 AC-10: a repo with no credentials skips repo-unavailable and is not retried', async () => {
      const s = gitlabSetup(['alice'], { connected: false });
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'repo-unavailable');
      expect(s.events.bumpAttempt).not.toHaveBeenCalled();
      expect(s.writer.mint).not.toHaveBeenCalled();
      // The verdict came from the credential store's own refusal, on the GitLab read path.
      expect(s.call).toHaveBeenCalledExactlyOnceWith({ id: 'r1', host: 'https://gitlab.com' }, 'read', expect.any(Function));
    });

    it('US-006 AC-11: a deployment without an encryption key retries the row', async () => {
      const s = gitlabSetup(['alice'], { encryptionKey: null });
      await s.minter.run();
      expect(s.events.bumpAttempt).toHaveBeenCalledWith(s.row.id);
      expect(s.writer.mint).not.toHaveBeenCalled();
    });
  });

  describe('US-006 GitHub provider regression', () => {
    it('US-006 AC-12: a GitLab username is not a GitHub login, so no role is read for it', async () => {
      const s = setup(['jane.doe', 'alice']);
      await s.minter.run();
      expect(s.github.getRepoRole).toHaveBeenCalledExactlyOnceWith('secret', 'acme', 'api', 'alice');
    });

    it('US-006 AC-13: a GitHub login makes the same token, role and thread calls as before', async () => {
      const s = setup(['alice']); const approval = recordedApproval(s);
      await s.minter.run();
      expect(s.github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(77n, 'api');
      expect(s.github.getRepoRole).toHaveBeenCalledExactlyOnceWith('secret', 'acme', 'api', 'alice');
      expect(s.github.getReviewThread).toHaveBeenCalledExactlyOnceWith('secret', 't1');
      expect(approval()).toEqual({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice' });
      expect(s.events.markMinted).toHaveBeenCalledWith(s.row.id, { memoryItemId: 'm1', approverLogin: 'alice' });
    });

    it('US-006 AC-14: a GitLab username alone leaves no GitHub writer and calls no GitHub method', async () => {
      const s = setup(['jane.doe']);
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'no-writer');
      expect(s.writer.mint).not.toHaveBeenCalled();
      expect(s.github.mintThreadReadToken).not.toHaveBeenCalled();
      expect(s.github.mintReadOnlyToken).not.toHaveBeenCalled();
      expect(s.github.getRepoRole).not.toHaveBeenCalled();
      expect(s.github.getReviewThread).not.toHaveBeenCalled();
    });
  });

  describe('US-004 author exclusion', () => {
    it('AC-3: excludes the GitHub PR author before selecting approver', async () => {
      const s = setup(['alice', 'carol']); const approval = recordedApproval(s);
      s.github.getPullRequest.mockResolvedValue({ author: 'ALICE' } as never);
      await s.minter.run();
      expect(approval()).toMatchObject({ approverId: 'github:carol', satisfiedBy: 'none' });
    });

    it('AC-4/5: skips and never mints when the sole GitHub writer is the PR author', async () => {
      const s = setup(['Alice']);
      s.github.getPullRequest.mockResolvedValue({ author: 'alice' } as never);
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'author-only');
      expect(s.writer.mint).not.toHaveBeenCalled();
    });

    it('AC-6: excludes a verified author and leaves the remaining GitHub writer unverified', async () => {
      const s = setup(['alice', 'carol']); const approval = recordedApproval(s);
      s.github.getPullRequest.mockResolvedValue({ author: 'alice' } as never);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ authors: ['alice'] }));
      await s.minter.run();
      expect(approval()).toMatchObject({ approverId: 'github:carol', satisfiedBy: 'none' });
    });

    it('AC-7: excludes the GitLab MR author before selecting approver', async () => {
      const s = gitlabSetup(['bob', 'dave'], { levels: { bob: 30, dave: 30 }, author: 'bob' }); const approval = recordedApproval(s);
      await s.minter.run();
      expect(approval()).toMatchObject({ approverId: 'gitlab:dave' });
    });

    it('AC-8: skips when the only GitLab writer is the MR author', async () => {
      const s = gitlabSetup(['bob'], { levels: { bob: 30 }, author: 'bob' });
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'author-only');
      expect(s.writer.mint).not.toHaveBeenCalled();
    });

    it('AC-9: skips GitHub PR permission-read failures', async () => {
      const s = setup(); s.github.getPullRequest.mockRejectedValue(new Error('provider failure'));
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'permission-check-failed');
      expect(s.writer.mint).not.toHaveBeenCalled();
    });

    it('AC-10: skips GitLab MR permission-read failures', async () => {
      const s = gitlabSetup(['bob'], { levels: { bob: 30 }, mergeRequestError: new Error('provider failure') });
      await s.minter.run();
      expect(s.events.markSkipped).toHaveBeenCalledWith(s.row.id, 'permission-check-failed');
      expect(s.writer.mint).not.toHaveBeenCalled();
    });

    it('AC-11: null GitLab MR preserves first-writer unverified fallback', async () => {
      const s = gitlabSetup(['dave', 'bob'], { levels: { bob: 30, dave: 30 }, author: null, discussion: { authors: [] } });
      const approval = recordedApproval(s);
      await s.minter.run();
      expect(s.gitlab.getMergeRequest).toHaveBeenCalledExactlyOnceWith(expect.anything(), 42);
      expect(approval()).toMatchObject({ approverId: 'gitlab:dave', satisfiedBy: 'none' });
    });

    it('AC-12: null GitHub PR preserves first-writer unverified fallback', async () => {
      const s = setup(['carol', 'alice']); const approval = recordedApproval(s);
      s.github.getReviewThread.mockResolvedValue(matchingThread({ authors: [] }));
      await s.minter.run();
      expect(s.github.getPullRequest).toHaveBeenCalledExactlyOnceWith('secret', 'acme', 'api', 42);
      expect(approval()).toMatchObject({ approverId: 'github:carol', satisfiedBy: 'none' });
    });
  });
});
