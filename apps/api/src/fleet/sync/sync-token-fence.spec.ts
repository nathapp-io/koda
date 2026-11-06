import { Logger } from '@nestjs/common';
import { createMock } from '@golevelup/ts-vitest';
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { createMockPrismaService, PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { FleetJobKind, FleetJobState } from '../../common/enums';
import type { FleetJobRecord, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { PrismaFleetJobRepository } from '../jobs/prisma-fleet-job.repository';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { PlacementService } from '../jobs/placement.service';
import { FenceService } from './fence.service';
import { CommandAckProcessor } from './command-ack.processor';
import type { ChatThreadRepository } from '../threads/domain/chat-thread.domain';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import type { GitToken } from '../common/protocol';
import { SyncService } from './sync.service';
import { parseSyncRequest } from './sync-request.parser';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';

const base = { protocolVersion: 4, bootId: 'b1', daemonVersion: '1', freeSlots: 0, jobs: [], commandAcks: [] };
const request = { jobId: 'j1', leaseEpoch: 1, repoId: 'r1' };
const repository = (id = 'r1'): FleetRepoRef => ({ id, projectId: 'p1', provider: 'github', owner: 'owner', name: id, defaultBranch: 'main', githubInstallationId: 1n });

function harness() {
  const repo = createMock<IFleetJobRepository>();
  const job = { id: 'j1', projectId: 'p1', repoId: 'anchor', runnerId: 'runner1', leaseEpoch: 1, command: FleetJobKind.THREAD, state: FleetJobState.RUNNING } as FleetJobRecord;
  const r1 = repository();
  repo.lockById.mockResolvedValue(job);
  repo.recordRunnerSync.mockResolvedValue({ previousBootId: 'b1' });
  repo.findPendingCommands.mockResolvedValue([]);
  repo.findThreadTokenScope.mockResolvedValue({ kind: 'PROJECT', action: 'SESSION' });
  repo.findThreadCredentialScope.mockResolvedValue({ projectId: 'p1', repoId: null });
  repo.findProjectRepos.mockResolvedValue([r1]);
  repo.findRepo.mockResolvedValue(repository('anchor'));
  const broker = createMock<GitTokenBroker>();
  const token: GitToken = { jobId: 'j1', repoId: 'r1', token: 'secret', username: 'x-access-token', expiresAt: '2027-01-01T00:00:00Z' };
  let inTransaction = false;
  broker.mint.mockImplementation(async () => {
    expect(inTransaction).toBe(false);
    return { ok: true, token };
  });
  const fence = createMock<FenceService>();
  fence.holds.mockReturnValue(true);
  const tx = createMock<ITransactionManager>({ run: async (fn) => {
    inTransaction = true;
    try { return await fn(); } finally { inTransaction = false; }
  } });
  const placement = createMock<PlacementService>();
  const service = new SyncService(repo, createMock(), createMock<CommandAckProcessor>({ process: async () => ({ live: [] }) }),
    placement, createMock(), createMock(), { syncWaitMs: 0 }, broker, fence,
    createMock(), createMock(), tx, createMock(), createMock<ChatThreadRepository>({ archivedThreadIds: async () => [] }),
    createMock<ProviderCredentialsService>(), createMock<FleetActivityService>());
  const sync = (requests: unknown[] = [request], overrides: Record<string, unknown> = {}) => service.sync('runner1', { ...base, ...overrides, tokenRequests: requests });
  return { repo, job, r1, broker, token, fence, placement, sync };
}

async function expectDenied(h: ReturnType<typeof harness>, repoId = 'r1', reason = 'repo_not_assigned') {
  const response = await h.sync([{ ...request, repoId }]);
  expect(response.gitTokenErrors).toEqual([{ jobId: 'j1', repoId, reason }]);
  expect(response.gitTokens).toEqual([]);
  expect(h.broker.mint).not.toHaveBeenCalled();
}

describe('sync repository token fence', () => {
  it('AC-1: marks runner sync bookkeeping at the repository write', async () => {
    const h = harness();
    h.repo.recordRunnerSync.mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBe('runner.heartbeat');
      return { previousBootId: 'b1' };
    });
    await h.sync([]);
    expect(h.repo.recordRunnerSync).toHaveBeenCalledTimes(1);
  });

  it('AC-2: marks command delivery at the delivered write', async () => {
    const h = harness();
    h.repo.findPendingCommands.mockResolvedValue([{ id: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: {}, deliveredAt: null } as never]);
    h.repo.markDelivered.mockImplementation(async () => {
      expect(currentBookkeepingReason()).toBe('runner.command-delivery');
    });
    await h.sync([]);
    expect(h.repo.markDelivered).toHaveBeenCalledTimes(1);
  });
  it('US-001 AC-1 to AC-4 refuses the PROJECT SESSION anchor token without repoId', async () => {
    const h = harness();
    const response = await h.sync([{ jobId: 'j1', leaseEpoch: 1 }]);
    expect(response.gitTokenErrors).toEqual([{ jobId: 'j1', reason: 'repo_not_assigned' }]);
    expect(response.gitTokens).toEqual([]);
    expect(h.broker.mint).not.toHaveBeenCalled();
    expect(h.repo.findRepo).not.toHaveBeenCalled();
  });

  it('US-001 AC-5 refuses a PROJECT PUBLISH anchor token without repoId', async () => {
    const h = harness();
    h.repo.findThreadTokenScope.mockResolvedValue({ kind: 'PROJECT', action: 'PUBLISH' });
    const response = await h.sync([{ jobId: 'j1', leaseEpoch: 1 }]);
    expect(response.gitTokenErrors).toEqual([{ jobId: 'j1', reason: 'repo_not_assigned' }]);
    expect(response.gitTokens).toEqual([]);
    expect(h.broker.mint).not.toHaveBeenCalled();
    expect(h.repo.findRepo).not.toHaveBeenCalled();
  });

  it('US-001 AC-6 keeps repo-less REPO thread grants on their anchor repo', async () => {
    const h = harness();
    h.repo.findThreadTokenScope.mockResolvedValue({ kind: 'REPO', action: 'SESSION' });
    const response = await h.sync([{ jobId: 'j1', leaseEpoch: 1 }]);
    expect(response.gitTokenErrors).toEqual([]);
    expect(h.repo.findRepo).toHaveBeenCalledExactlyOnceWith('anchor');
    expect(h.broker.mint).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', leaseEpoch: 1, repo: repository('anchor') }, expect.any(Date));
  });

  it('workspace AC-7 refuses the anchor token without repoId', async () => {
    const h = harness();
    h.repo.findThreadTokenScope.mockResolvedValue({ kind: 'WORKSPACE', action: 'SESSION' });
    const response = await h.sync([{ jobId: 'j1', leaseEpoch: 1 }]);
    expect(response.gitTokenErrors).toEqual([{ jobId: 'j1', reason: 'repo_not_assigned' }]);
    expect(response.gitTokens).toEqual([]);
    expect(h.broker.mint).not.toHaveBeenCalled();
    expect(h.repo.findRepo).not.toHaveBeenCalled();
  });
  it('AC-1 preserves repoId only when present', () => {
    const legacy = { jobId: 'j1', leaseEpoch: 1 };
    expect(parseSyncRequest({ ...base, tokenRequests: [request, legacy] }).tokenRequests).toStrictEqual([request, legacy]);
  });

  it.each(['', 12, 'r'.repeat(65), null, undefined])('AC-2 rejects present invalid repoId %s with tokenRequest reason', (repoId) => {
    let error: unknown;
    try { parseSyncRequest({ ...base, tokenRequests: [{ ...request, repoId }] }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ValidationAppException);
    expect(error).toMatchObject({ args: { reason: 'tokenRequest' } });
  });

  it('AC-3 mints the selected project repository read-only outside the transaction', async () => {
    const h = harness();
    await h.sync();
    expect(h.repo.findThreadTokenScope).toHaveBeenCalledWith('j1');
    expect(h.repo.findProjectRepos).toHaveBeenCalledWith('p1');
    expect(h.broker.mint).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', leaseEpoch: 1, repo: h.r1, readOnly: true }, expect.any(Date));
    expect(h.repo.findRepo).not.toHaveBeenCalled();
  });

  it('AC-4 returns the broker token with repoId', async () => {
    const h = harness();
    expect((await h.sync()).gitTokens).toEqual([h.token]);
    expect(h.broker.mint).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }), expect.any(Date));
  });

  it('AC-5 denies a repository outside this project', async () => { await expectDenied(harness(), 'other-project-repo'); });

  it('AC-6 denies a REPO thread', async () => {
    const h = harness();
    h.repo.findThreadTokenScope.mockResolvedValue({ kind: 'REPO', action: 'SESSION' });
    await expectDenied(h);
  });

  it('AC-7 denies PUBLISH', async () => {
    const h = harness();
    h.repo.findThreadTokenScope.mockResolvedValue({ kind: 'PROJECT', action: 'PUBLISH' });
    await expectDenied(h);
  });

  it('AC-8 denies RUN without reading thread scope', async () => {
    const h = harness(); h.job.command = FleetJobKind.RUN;
    await expectDenied(h);
    expect(h.repo.findThreadTokenScope).not.toHaveBeenCalled();
  });

  it('AC-9 denies the eleventh fetchable repo but grants the tenth', async () => {
    const h = harness();
    const repos = Array.from({ length: 11 }, (_, i) => repository(`r${i + 1}`));
    h.repo.findProjectRepos.mockResolvedValue(repos);
    await expectDenied(h, 'r11');
    await h.sync([{ ...request, repoId: 'r10' }]);
    expect(h.broker.mint).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', leaseEpoch: 1, repo: repos[9], readOnly: true }, expect.any(Date));
  });

  it('AC-10 denies GitLab and GitHub without an installation', async () => {
    const h = harness();
    h.repo.findProjectRepos.mockResolvedValue([{ ...repository('g1'), provider: 'gitlab' }, { ...repository('n1'), githubInstallationId: null }]);
    await expectDenied(h, 'g1');
    await expectDenied(h, 'n1');
  });

  it('AC-11 echoes repoId for a held terminal job', async () => {
    const h = harness(); h.job.state = FleetJobState.COMPLETED;
    await expectDenied(h, 'r1', 'job_not_active');
    expect(h.repo.findThreadTokenScope).not.toHaveBeenCalled();
  });

  it('AC-12 keeps the legacy RUN mint shape without readOnly', async () => {
    const h = harness(); h.job.command = FleetJobKind.RUN;
    await h.sync([{ jobId: 'j1', leaseEpoch: 1 }]);
    expect(h.repo.findRepo).toHaveBeenCalledWith('anchor');
    expect(h.broker.mint).toHaveBeenCalledExactlyOnceWith({ jobId: 'j1', leaseEpoch: 1, repo: repository('anchor') }, expect.any(Date));
    expect(h.repo.findThreadTokenScope).not.toHaveBeenCalled();
    expect(h.repo.findProjectRepos).not.toHaveBeenCalled();
  });

  it('AC-13 abandons another runner lease before scope lookup', async () => {
    const h = harness(); h.fence.holds.mockReturnValue(false);
    const response = await h.sync();
    expect(h.fence.holds).toHaveBeenCalledWith(h.job, 'runner1', 1);
    expect(h.fence.abandon).toHaveBeenCalledExactlyOnceWith('runner1', h.job, 1);
    expect(h.broker.mint).not.toHaveBeenCalled();
    expect(h.repo.findThreadTokenScope).not.toHaveBeenCalled();
    expect(response.gitTokenErrors).toEqual([]);
  });

  it('denies a missing thread scope', async () => {
    const h = harness(); h.repo.findThreadTokenScope.mockResolvedValue(null);
    await expectDenied(h);
  });

  it('keeps unknown jobs on the unknownJobIds path', async () => {
    const h = harness(); h.repo.lockById.mockResolvedValue(null);
    const response = await h.sync();
    expect(response.unknownJobIds).toEqual(['j1']);
    expect(response.gitTokenErrors).toEqual([]);
    expect(h.broker.mint).not.toHaveBeenCalled();
  });

  it('US-002 AC-6..8,14 continues command and token delivery after fillRunner rejects', async () => {
    const h = harness();
    h.job.command = FleetJobKind.RUN;
    h.placement.fillRunner.mockRejectedValue(Object.assign(new Error('private detail'), { name: 'PlacementError' }));
    const rows = [{ id: 'c1', type: 'CANCEL', jobId: 'j1', leaseEpoch: 1, payload: { reason: 'done' }, deliveredAt: null }];
    h.repo.findPendingCommands.mockResolvedValue(rows as never);
    const error = vi.spyOn(Logger.prototype, 'error').mockClear();

    const response = await h.sync([{ jobId: 'j1', leaseEpoch: 1 }], { freeSlots: 2 });

    expect(response.commands).toEqual([{ commandId: 'c1', type: 'CANCEL', jobId: 'j1', leaseEpoch: 1, payload: { reason: 'done' } }]);
    expect(response.gitTokens).toEqual([h.token]);
    expect(error).toHaveBeenCalledWith('Sync: placement for runner runner1 failed: PlacementError');
    expect(error.mock.calls.flat().join(' ')).not.toContain('private detail');
    // The global test setup owns the no-op Logger spies for the whole file (US-002 M1): restoring this
    // one would put the real Nest logger back for every later test here, so clear it instead.
    error.mockClear();
  });

  it('US-002 AC-9 calls thread placement even when fillRunner rejects', async () => {
    const h = harness();
    h.placement.fillRunner.mockRejectedValue(new Error('placement failed'));
    await h.sync([], { freeSlots: 1, protocolVersion: 4 });
    expect(h.placement.fillRunnerThreads).toHaveBeenCalledOnce();
  });

  it('US-002 AC-10..13 continues command and token delivery after fillRunnerThreads rejects', async () => {
    const h = harness();
    h.job.command = FleetJobKind.RUN;
    h.placement.fillRunnerThreads.mockRejectedValue(Object.assign(new Error('private detail'), { name: 'PlacementError' }));
    const rows = [{ id: 'c2', type: 'ABANDON', jobId: 'j1', leaseEpoch: 1, payload: {}, deliveredAt: null }];
    h.repo.findPendingCommands.mockResolvedValue(rows as never);
    const error = vi.spyOn(Logger.prototype, 'error').mockClear();

    const response = await h.sync([{ jobId: 'j1', leaseEpoch: 1 }], { freeSlots: 1, protocolVersion: 4 });

    expect(response.commands).toEqual([{ commandId: 'c2', type: 'ABANDON', jobId: 'j1', leaseEpoch: 1, payload: {} }]);
    expect(response.gitTokens).toEqual([h.token]);
    expect(error).toHaveBeenCalledWith('Sync: placement for runner runner1 failed: PlacementError');
    expect(error.mock.calls.flat().join(' ')).not.toContain('private detail');
    // The global test setup owns the no-op Logger spies for the whole file (US-002 M1): restoring this
    // one would put the real Nest logger back for every later test here, so clear it instead.
    error.mockClear();
  });

  it('US-002 M1: the shared no-op logger spies still guard the cases after the placement ones', () => {
    expect(vi.isMockFunction(Logger.prototype.error)).toBe(true);
    expect(vi.isMockFunction(Logger.prototype.warn)).toBe(true);
  });
});

describe('thread token scope persistence projection', () => {
  it('AC-14 reads PROJECT SESSION and returns null without a turn', async () => {
    const prisma = createMockPrismaService({ fn: vi.fn });
    const findUnique = vi.fn().mockResolvedValueOnce({ action: 'SESSION', thread: { kind: 'PROJECT' } }).mockResolvedValueOnce(null);
    prisma.client.fleetThreadTurn = { findUnique };
    const repo = new PrismaFleetJobRepository(prisma as unknown as PrismaService<PrismaClient>);
    expect(await repo.findThreadTokenScope('thread-job')).toEqual({ kind: 'PROJECT', action: 'SESSION' });
    expect(findUnique).toHaveBeenCalledWith({ where: { jobId: 'thread-job' }, select: { action: true, thread: { select: { kind: true } } } });
    expect(await repo.findThreadTokenScope('run-job')).toBeNull();
  });
});
