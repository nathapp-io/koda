import { createMock } from '@golevelup/ts-vitest';
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { createMockPrismaService, PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { FleetJobKind, FleetJobState } from '../../common/enums';
import type { FleetJobRecord, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { PrismaFleetJobRepository } from '../jobs/prisma-fleet-job.repository';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { FenceService } from './fence.service';
import { CommandAckProcessor } from './command-ack.processor';
import type { ChatThreadRepository } from '../threads/domain/chat-thread.domain';
import type { GitToken } from '../common/protocol';
import { SyncService } from './sync.service';
import { parseSyncRequest } from './sync-request.parser';

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
  const service = new SyncService(repo, createMock(), createMock<CommandAckProcessor>({ process: async () => ({ live: [], approvalLive: [] }) }),
    createMock(), createMock(), createMock(), createMock(), { syncWaitMs: 0 }, broker, fence,
    createMock(), createMock(), tx, createMock(), createMock<ChatThreadRepository>({ archivedThreadIds: async () => [] }));
  const sync = (requests: unknown[] = [request]) => service.sync('runner1', { ...base, tokenRequests: requests });
  return { repo, job, r1, broker, token, fence, sync };
}

async function expectDenied(h: ReturnType<typeof harness>, repoId = 'r1', reason = 'repo_not_assigned') {
  const response = await h.sync([{ ...request, repoId }]);
  expect(response.gitTokenErrors).toEqual([{ jobId: 'j1', repoId, reason }]);
  expect(response.gitTokens).toEqual([]);
  expect(h.broker.mint).not.toHaveBeenCalled();
}

describe('sync repository token fence', () => {
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
