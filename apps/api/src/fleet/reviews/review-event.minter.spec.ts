import { Logger } from '@nestjs/common';
import { currentContext } from '../../action-context/action-context';
import { currentBookkeepingReason, noteAuditWrite } from '../../action-context/audit-coverage';
import { ReviewEventMinter } from './review-event.minter';
import type { FleetReviewEventRecord } from './domain/fleet-review-event.domain';
import type { ReviewThreadInfo } from '../git-broker/github-app-client';

/** The thread `disagreedBy` names: PR 42 of acme/api with alice as a comment author. */
const matchingThread = (over: Partial<ReviewThreadInfo> = {}): ReviewThreadInfo => ({
  repoOwner: 'acme', repoName: 'api', prNumber: 42, authors: ['alice'], ...over,
});

function setup(logins = ['alice']) {
  const row: FleetReviewEventRecord = {
    id: 'event-1', projectId: 'p1', repoId: 'r1', jobId: 'j1', leaseEpoch: 1, prNumber: 42,
    findingKey: 'f-12345678', threadId: 't1', finding: 'missing guard', reason: 'guarded upstream',
    file: null, line: null, disagreedBy: logins, trusted: true, status: 'pending', skipReason: null,
    approverLogin: null, memoryItemId: null, attempts: 0, createdAt: new Date(0), updatedAt: new Date(0),
  };
  const bookkeeping = () => {
    expect(currentBookkeepingReason()).toBe('fleet.review-event-bookkeeping');
    noteAuditWrite('FleetReviewEvent.update');
  };
  const events = {
    claimPending: vi.fn(async () => { expect(currentBookkeepingReason()).toBeUndefined(); return [row]; }),
    markMinted: vi.fn(async () => { bookkeeping(); }), markSkipped: vi.fn(async () => { bookkeeping(); }),
    bumpAttempt: vi.fn(async () => { bookkeeping(); return 1; }),
  };
  const repos = { findReviewRepo: vi.fn().mockResolvedValue({ id: 'r1', projectId: 'p1', owner: 'acme', name: 'api', githubInstallationId: 77n }) };
  const minted = () => ({ token: 'secret', expiresAt: new Date() });
  const github = {
    mintThreadReadToken: vi.fn(minted), mintReadOnlyToken: vi.fn(minted),
    getRepoRole: vi.fn().mockResolvedValue('write'), getReviewThread: vi.fn().mockResolvedValue(matchingThread()),
  };
  const writer = { guard: vi.fn().mockResolvedValue(null), mint: vi.fn(async () => ({ status: 'minted' as const, memoryItemId: 'm1' })) };
  const minter = new ReviewEventMinter(events as never, repos as never, github as never, writer as never);
  return { row, events, repos, github, writer, minter };
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
    /** What the mint saw, so a case can assert the approval block without depending on call order. */
    const recordedApproval = (s: ReturnType<typeof setup>) => {
      let seen: unknown;
      s.writer.mint.mockImplementation(async () => {
        seen = currentContext()?.approval;
        return { status: 'minted', memoryItemId: 'm1' };
      });
      return () => seen;
    };

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
});
