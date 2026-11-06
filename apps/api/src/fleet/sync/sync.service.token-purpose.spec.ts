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
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';

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
    createMock<ProviderCredentialsService>(), createMock<FleetActivityService>(),
  );
  const sync = (fresh = false) => service.sync('runner-1', { ...base, tokenRequests: [{ jobId: job.id, leaseEpoch: job.leaseEpoch, ...(fresh ? { fresh: true } : {}) }] });
  return { sync, github, job, repo, broker };
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

  it.each([
    [FleetJobKind.FIX, true, true, 'AC-10'],
    [FleetJobKind.REVIEW, true, true, 'AC-11'],
    [FleetJobKind.RUN, true, false, 'AC-12'],
    [FleetJobKind.FIX, false, false, 'AC-13'],
  ])('%s fresh=%s forwards only the authorized fresh flag (%s)', async (command, requestFresh, expectedFresh) => {
    const h = harness(command);
    const mint = vi.spyOn(h.broker, 'mint').mockResolvedValue({ ok: false, error: { jobId: 'job-1', reason: 'provider_error' } });
    await h.sync(requestFresh);
    const request = mint.mock.calls[0]?.[0];
    expect(request).toEqual({ jobId: 'job-1', leaseEpoch: 7, repo: h.repo, ...(expectedFresh ? { fresh: true } : {}), ...(command === FleetJobKind.REVIEW ? { purpose: 'review' } : command === FleetJobKind.FIX ? { purpose: 'fix' } : {}) });
    expect(Object.prototype.hasOwnProperty.call(request, 'fresh')).toBe(expectedFresh);
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

  /**
   * US-005: the AGENT job's default (repo-less) token request is answered by the broker's read purpose, which is
   * a GitHub read-only mint carrying no `repoId`. A RUN job keeps the purpose-less write mint.
   */
  it('US-005 AC-10: grants the read purpose for an ASSIGNED AGENT job default token request', async () => {
    const h = harness(FleetJobKind.AGENT);
    const mint = vi.spyOn(h.broker, 'mint');
    const response = await h.sync();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toEqual({ jobId: 'job-1', leaseEpoch: 7, repo: h.repo, purpose: 'read' });
    // The real broker ran: read-only, no write token, and no repository attribution on the granted token.
    expect(h.github.mintReadOnlyToken).toHaveBeenCalledExactlyOnceWith(42n, 'repo');
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(response.gitTokens).toEqual([expect.objectContaining({ jobId: 'job-1', token: 'read-token' })]);
    expect(Object.prototype.hasOwnProperty.call(response.gitTokens[0], 'repoId')).toBe(false);
  });

  it('US-005 AC-11: keeps the RUN default token request purpose-less', async () => {
    const h = harness(FleetJobKind.RUN);
    const mint = vi.spyOn(h.broker, 'mint');
    await h.sync();
    expect(mint).toHaveBeenCalledTimes(1);
    const request = mint.mock.calls[0]?.[0];
    expect(request).toEqual({ jobId: 'job-1', leaseEpoch: 7, repo: h.repo });
    expect(Object.prototype.hasOwnProperty.call(request, 'purpose')).toBe(false);
    expect(h.github.mintInstallationToken).toHaveBeenCalledExactlyOnceWith(42n, 'repo');
    expect(h.github.mintReadOnlyToken).not.toHaveBeenCalled();
  });
});
