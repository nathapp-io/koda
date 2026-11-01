import { createMock } from '@golevelup/ts-vitest';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { FleetJobRecord, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FleetJobKind, FleetJobState } from '../../common/enums';
import type { GitToken } from '../common/protocol';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import { FenceService } from './fence.service';
import { SyncService } from './sync.service';
import type { ChatThreadRepository } from '../threads/domain/chat-thread.domain';

const base = { protocolVersion: 4, bootId: 'b1', daemonVersion: '1', freeSlots: 0, jobs: [], commandAcks: [] };
const repo: FleetRepoRef = { id: 'repo-1', projectId: 'project-1', provider: 'github', owner: 'acme', name: 'repo', defaultBranch: 'main', githubInstallationId: 42n };

function harness(command: FleetJobKind) {
  const repository = createMock<IFleetJobRepository>();
  const job = { id: 'job-1', projectId: 'project-1', repoId: repo.id, runnerId: 'runner-1', leaseEpoch: 7, command, state: FleetJobState.ASSIGNED } as FleetJobRecord;
  repository.lockById.mockResolvedValue(job);
  repository.recordRunnerSync.mockResolvedValue({ previousBootId: 'b1' });
  repository.findPendingCommands.mockResolvedValue([]);
  repository.findRepo.mockResolvedValue(repo);
  const github = createMock<GitHubAppClient>();
  github.mintReviewToken.mockResolvedValue({ token: 'review-token', expiresAt: new Date('2030-01-01T00:00:00Z') });
  github.mintReadOnlyToken.mockResolvedValue({ token: 'read-token', expiresAt: new Date('2030-01-01T00:00:00Z') });
  github.isBranchProtected.mockResolvedValue(false);
  github.mintInstallationToken.mockResolvedValue({ token: 'write-token', expiresAt: new Date('2030-01-01T00:00:00Z') });
  const broker = new GitTokenBroker({ gitTokenReuseMarginSec: 30, gitlabTokenTtlSec: 300 } as never, github, createMock<GitLabTokenSource>());
  const txManager = createMock<ITransactionManager>({ run: async (fn) => fn() });
  const fence = createMock<FenceService>();
  fence.holds.mockReturnValue(true);
  const service = new SyncService(
    repository, createMock(), createMock({ process: async () => ({ live: [] }) }), createMock(), createMock(), createMock(),
    { syncWaitMs: 0 }, broker, fence, createMock(), createMock(), txManager, createMock(),
    createMock<ChatThreadRepository>({ archivedThreadIds: async () => [] }),
  );
  const sync = () => service.sync('runner-1', { ...base, tokenRequests: [{ jobId: job.id, leaseEpoch: job.leaseEpoch }] });
  return { sync, github, job, repo };
}

describe('SyncService repo-less token purpose', () => {
  it('AC-1: mints a REVIEW token through the real broker', async () => {
    const h = harness(FleetJobKind.REVIEW);
    await h.sync();
    expect(h.github.mintReviewToken).toHaveBeenCalledExactlyOnceWith(42n, 'repo');
  });

  it('AC-2: never mints an installation write token for REVIEW', async () => {
    const h = harness(FleetJobKind.REVIEW);
    await h.sync();
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-3: returns the unprotected-default-branch token error for FIX', async () => {
    const h = harness(FleetJobKind.FIX);
    const response = await h.sync();
    expect(response.gitTokenErrors).toContainEqual({ jobId: 'job-1', reason: 'default_branch_unprotected' });
  });

  it('AC-4: returns no token when a FIX repo default branch is unprotected', async () => {
    const h = harness(FleetJobKind.FIX);
    expect((await h.sync()).gitTokens).toEqual([]);
  });

  it('AC-5: preserves the exact RUN broker request without a purpose key', async () => {
    const h = harness(FleetJobKind.RUN);
    const mint = vi.spyOn(GitTokenBroker.prototype, 'mint');
    try {
      await h.sync();
      const request = mint.mock.calls[0]?.[0];
      expect(request).toEqual({ jobId: 'job-1', leaseEpoch: 7, repo: h.repo });
      expect(Object.prototype.hasOwnProperty.call(request, 'purpose')).toBe(false);
    } finally {
      mint.mockRestore();
    }
  });
});
