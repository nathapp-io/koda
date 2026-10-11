import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { DuplicateActiveJobError, FleetJobRecord, FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { CONFIG_JOB_FEATURE, ConfigJobsService } from './config-jobs.service';
import { ConfigJobActiveException } from './repo-config.exceptions';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const SHA = 'a'.repeat(40);
const REPO: FleetRepoRef = { id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) };

const record = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'job-1', projectId: 'p1', repoId: 'repo-1', ref: 'trunk', command: 'CONFIG_EDIT', feature: CONFIG_JOB_FEATURE, planFrom: null, threadId: null, profiles: [],
  maxCostUsd: '0', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, runnerId: null, runnerBootId: null,
  leaseEpoch: 0, state: 'QUEUED', stateReason: null, requestedById: 'u1', queuedAt: NOW, assignedAt: null, startedAt: null, finishedAt: null,
  cancelRequestedAt: null, naxRunId: null, naxLogRunId: null, naxCostRunId: null, progress: null, currentStoryId: null, currentPhase: null,
  costSpentUsd: '0', costCarriedUsd: '0', firstStartedAt: null, cancelReason: null, scheduleId: null, coalescedCount: 0, scheduleCountedAt: null,
  lastHeartbeatAt: null, finishResult: null, escalationReason: null, exitCode: null, resultBranch: null, resultSha: null, resultPrUrl: null,
  wipPush: null, stories: null, storiesTruncated: false, postRun: null, configResult: null, eventSeq: 0, ackedRunnerSeq: 0, attributedAt: null,
  updatedAt: NOW, ...over,
});

function setup() {
  const jobs = {
    findRepo: vi.fn(async (id: string) => (id === 'repo-1' ? REPO : id === 'foreign' ? { ...REPO, id, projectId: 'p2' } : null)),
    createJob: vi.fn(async (data: Partial<FleetJobRecord>) => record({ ...data } as Partial<FleetJobRecord>)),
    appendEvent: vi.fn(),
    findActiveJobId: vi.fn(async () => 'job-active'),
    findById: vi.fn(async () => record()),
    lockById: vi.fn(async () => record()),
  };
  const edits = {
    create: vi.fn(async (d: Record<string, unknown>) => ({ id: 'e1', result: null, createdAt: NOW, ...d })),
    findByJobId: vi.fn(async () => ({ id: 'e1', jobId: 'job-1', mode: 'edit', edits: [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }], prTitle: 'T', prBody: null, baseSha: SHA, result: null, createdAt: NOW })),
  };
  const reader = { list: vi.fn(async () => ({ baseSha: 'b'.repeat(40), defaultBranch: 'trunk', files: [] })), read: vi.fn(async () => ({ path: '.nax/context.md', blobSha: 'k', content: 'x' })) };
  const activity = { record: vi.fn() };
  const live = { event: vi.fn(() => ({ id: 'l' })), publish: vi.fn() };
  const placement = { placeJob: vi.fn(async () => ({ assigned: false, runnerId: null, leaseEpoch: null, misfits: [] })) };
  const fence = { holds: vi.fn((j: FleetJobRecord, r: string, e: number) => j.runnerId === r && j.leaseEpoch === e), abandon: vi.fn() };
  const tx = { run: (fn: () => unknown) => fn() };
  const svc = new ConfigJobsService(jobs as never, edits as never, reader as never, activity as never, live as never, placement as never, fence as never, tx as never);
  return { svc, jobs, edits, reader, activity, placement, fence };
}

describe('ConfigJobsService (fleet S3 §4)', () => {
  const body = { baseSha: SHA, edits: [{ path: '.nax/context.md', op: 'put' as const, content: '# x', baseSha: null }], prTitle: ' Tighten ', prBody: undefined };

  it('creates a CONFIG_EDIT job with the fixed columns, its edit row and a QUEUED event, then places it', async () => {
    const { svc, jobs, edits, placement, activity } = setup();
    const res = await svc.submitEdit('u1', 'p1', 'repo-1', body);
    expect(jobs.createJob).toHaveBeenCalledWith({
      projectId: 'p1', repoId: 'repo-1', ref: 'trunk', command: 'CONFIG_EDIT', feature: 'nax-config', planFrom: null, profiles: [],
      maxCostUsd: '0', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, requestedById: 'u1',
    });
    expect(edits.create).toHaveBeenCalledWith({ jobId: 'job-1', mode: 'edit', edits: body.edits, prTitle: 'Tighten', prBody: null, baseSha: SHA });
    expect(jobs.appendEvent).toHaveBeenCalledWith('job-1', { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'job.dispatched', payload: expect.objectContaining({ command: 'CONFIG_EDIT', mode: 'edit', files: ['.nax/context.md'] }) }));
    expect(placement.placeJob).toHaveBeenCalledWith('job-1');
    expect(res.job.configEdit).toEqual({ mode: 'edit', files: ['.nax/context.md'], prTitle: 'Tighten', result: null });
  });

  it('answers 409 config_job_active naming the active job', async () => {
    const { svc, jobs } = setup();
    jobs.createJob.mockRejectedValueOnce(new DuplicateActiveJobError());
    await expect(svc.submitEdit('u1', 'p1', 'repo-1', body)).rejects.toEqual(expect.any(ConfigJobActiveException));
    expect(jobs.findActiveJobId).toHaveBeenCalledWith('repo-1', 'nax-config');
  });

  it('refuses a repo of another project (404) and an invalid edit set (400) before any write', async () => {
    const { svc, jobs } = setup();
    await expect(svc.submitEdit('u1', 'p1', 'foreign', body)).rejects.toBeInstanceOf(NotFoundAppException);
    await expect(svc.submitEdit('u1', 'p1', 'repo-1', { ...body, edits: [{ path: '.nax/profiles/x.env', op: 'put', content: 'K=V', baseSha: null }] }))
      .rejects.toBeInstanceOf(ValidationAppException);
    await expect(svc.submitEdit('u1', 'p1', 'repo-1', { ...body, prTitle: '' })).rejects.toBeInstanceOf(ValidationAppException);
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it('regenerate and drift read the current head as baseSha and carry no edits', async () => {
    const { svc, jobs, edits } = setup();
    await svc.submitRegenerate('u1', 'p1', 'repo-1', { prTitle: 'Regenerate agent files' });
    expect(edits.create).toHaveBeenLastCalledWith({ jobId: 'job-1', mode: 'regenerate', edits: [], prTitle: 'Regenerate agent files', prBody: null, baseSha: 'b'.repeat(40) });
    await svc.submitDrift('u1', 'p1', 'repo-1');
    expect(jobs.createJob).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'CONFIG_DRIFT', feature: 'nax-config' }));
    expect(edits.create).toHaveBeenLastCalledWith({ jobId: 'job-1', mode: 'drift', edits: [], prTitle: null, prBody: null, baseSha: 'b'.repeat(40) });
  });

  it('reads a file at the given ref or the default branch, refusing a non-allowlisted path', async () => {
    const { svc, reader } = setup();
    await svc.readFile('p1', 'repo-1', '.nax/context.md', undefined);
    expect(reader.read).toHaveBeenLastCalledWith(REPO, '.nax/context.md', 'trunk');
    await svc.readFile('p1', 'repo-1', '.nax/context.md', SHA);
    expect(reader.read).toHaveBeenLastCalledWith(REPO, '.nax/context.md', SHA);
    await expect(svc.readFile('p1', 'repo-1', '.nax/profiles/x.env', undefined)).rejects.toBeInstanceOf(ValidationAppException);
    await expect(svc.readFile('p1', 'repo-1', '.nax/context.md', 'feature/x')).rejects.toBeInstanceOf(ValidationAppException);
  });

  describe('fetchForRunner (spec §3, D478)', () => {
    it('returns the edit set to the lease holder in ASSIGNED or RUNNING', async () => {
      const { svc, jobs } = setup();
      for (const state of ['ASSIGNED', 'RUNNING'] as const) {
        jobs.lockById.mockResolvedValueOnce(record({ runnerId: 'r1', leaseEpoch: 2, state }));
        await expect(svc.fetchForRunner('r1', 'job-1', '2')).resolves.toEqual({
          mode: 'edit', edits: [{ path: '.nax/context.md', op: 'put', content: '# x', baseSha: null }], prTitle: 'T', prBody: null, baseSha: SHA,
        });
      }
    });

    it('fences another runner or a stale epoch with ABANDON + 409', async () => {
      const { svc, jobs, fence } = setup();
      jobs.lockById.mockResolvedValue(record({ runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING' }));
      await expect(svc.fetchForRunner('r2', 'job-1', '2')).rejects.toBeInstanceOf(FleetFenceException);
      await expect(svc.fetchForRunner('r1', 'job-1', '1')).rejects.toBeInstanceOf(FleetFenceException);
      expect(fence.abandon).toHaveBeenCalledTimes(2);
    });

    it('answers 409 jobState outside ASSIGNED/RUNNING, 404 for a nax job or an unknown job, 400 for a bad epoch', async () => {
      const { svc, jobs } = setup();
      jobs.lockById.mockResolvedValueOnce(record({ runnerId: 'r1', leaseEpoch: 2, state: 'UPLOADING' }));
      await expect(svc.fetchForRunner('r1', 'job-1', '2')).rejects.toBeInstanceOf(ConflictAppException);
      jobs.lockById.mockResolvedValueOnce(record({ runnerId: 'r1', leaseEpoch: 2, state: 'RUNNING', command: 'RUN' }));
      await expect(svc.fetchForRunner('r1', 'job-1', '2')).rejects.toBeInstanceOf(NotFoundAppException);
      jobs.lockById.mockResolvedValueOnce(null);
      await expect(svc.fetchForRunner('r1', 'job-1', '2')).rejects.toBeInstanceOf(NotFoundAppException);
      await expect(svc.fetchForRunner('r1', 'job-1', 'x')).rejects.toBeInstanceOf(ValidationAppException);
      await expect(svc.fetchForRunner('r1', 'job-1', undefined)).rejects.toBeInstanceOf(ValidationAppException);
    });
  });
});
