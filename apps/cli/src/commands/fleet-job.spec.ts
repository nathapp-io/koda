jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
const mockWriteFile = jest.fn();
jest.mock('fs/promises', () => ({ writeFile: (...a: unknown[]) => mockWriteFile(...a) }));
jest.mock('../generated', () => ({
  fleetJobsControllerList: jest.fn(),
  fleetJobsControllerGet: jest.fn(),
  fleetJobsControllerCancel: jest.fn(),
  fleetJobsControllerRequeue: jest.fn(),
  jobBundleControllerDownload: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import {
  fleetJobsControllerCancel,
  fleetJobsControllerGet,
  fleetJobsControllerList,
  fleetJobsControllerRequeue,
  jobBundleControllerDownload,
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const repo = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true, profiles: [] };
const job = (over = {}) => ({
  id: 'j1', projectId: 'p', repoId: 'fr1', ref: 'main', command: 'RUN', feature: 'login', planFrom: null, profiles: ['fast'],
  maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null, runnerId: 'r1', leaseEpoch: 1,
  state: 'RUNNING', stateReason: null, requestedById: 'u1', queuedAt: '2026-10-01T10:00:00.000Z',
  currentStoryId: 'US-002', currentPhase: 'implement', costSpentUsd: '1.2500', finishResult: null,
  escalationReason: null, resultBranch: null, resultPrUrl: null, ...over,
});
const page = <T>(records: T[], hasNext = false) => ({ ret: 0, data: { total: records.length, current: 1, size: 20, hasNext, hasPrev: false, records } });

describe('koda fleet job', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'job', ...a]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([repo]));
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([box]));
    mockWriteFile.mockReset();
  });

  afterEach(() => jest.clearAllMocks());

  it('list filters by state, repo name and runner name, and shows runner names', async () => {
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job()], true));
    await run('list', '--state', 'RUNNING', '--repo', 'acme/app', '--runner', 'box-1', '--requested-by', 'u1');
    expect(fleetJobsControllerList).toHaveBeenCalledWith({
      path: { slug: 'web' },
      query: { current: 1, size: 20, state: 'RUNNING', repoId: 'fr1', runnerId: 'r1', requestedById: 'u1' },
    });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('box-1');
    expect(out).toContain('Next: --page 2');
  });

  it('list rejects an unknown --state before any request (exit 3)', async () => {
    await run('list', '--state', 'DONE');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetJobsControllerList).not.toHaveBeenCalled();
  });

  it('show prints the job fields with runner name, story, phase and cost', async () => {
    (fleetJobsControllerGet as jest.Mock).mockResolvedValue({ ret: 0, data: job({ bashMode: 'escalate', approvalTimeoutSec: 600, pendingApprovals: 2 }) });
    await run('show', 'j1');
    expect(fleetJobsControllerGet).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    const out = logSpy.mock.calls.flat().join('\n');
    for (const want of ['RUNNING', 'box-1', 'US-002', 'implement', '1.2500', '5', 'escalate (asks wait 600 s)', 'Pending approvals']) expect(out).toContain(want);
  });

  it('cancel posts and prints the new state', async () => {
    (fleetJobsControllerCancel as jest.Mock).mockResolvedValue({ ret: 0, data: job({ state: 'RUNNING', cancelRequestedAt: '2026-10-01T10:05:00.000Z' }) });
    await run('cancel', 'j1');
    expect(fleetJobsControllerCancel).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Cancel requested');
  });

  it('requeue prints the placement', async () => {
    (fleetJobsControllerRequeue as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job({ id: 'j1', state: 'QUEUED' }), placement: { assigned: false, runnerId: null, misfits: [] } } });
    await run('requeue', 'j1');
    expect(fleetJobsControllerRequeue).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Queued: no runner fits now');
  });

  it('requeue still prints the job and exits 0 when the runner-name lookup fails', async () => {
    (fleetJobsControllerRequeue as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job({ state: 'QUEUED' }), placement: { assigned: true, runnerId: 'r1', misfits: [] } } });
    (projectFleetRunnersControllerList as jest.Mock).mockRejectedValue(new Error('network down'));
    await run('requeue', 'j1');
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Job j1 QUEUED');
    expect(out).toContain('Assigned to r1');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('bundle writes the bytes to koda-job-<id>.tar.gz without overwriting', async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer;
    (jobBundleControllerDownload as jest.Mock).mockResolvedValue(bytes);
    mockWriteFile.mockResolvedValue(undefined);
    await run('bundle', 'j1');
    expect(jobBundleControllerDownload).toHaveBeenCalledWith({ path: { slug: 'web', id: 'j1' }, parseAs: 'arrayBuffer' });
    const [path, data, opts] = mockWriteFile.mock.calls[0];
    expect(path).toBe('koda-job-j1.tar.gz');
    expect(Buffer.from(data as Uint8Array)).toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(opts).toEqual({ flag: 'wx' });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('bundle --out --force overwrites the named file', async () => {
    (jobBundleControllerDownload as jest.Mock).mockResolvedValue(new ArrayBuffer(1));
    mockWriteFile.mockResolvedValue(undefined);
    await run('bundle', 'j1', '--out', 'b.tgz', '--force');
    expect(mockWriteFile.mock.calls[0][0]).toBe('b.tgz');
    expect(mockWriteFile.mock.calls[0][2]).toEqual({ flag: 'w' });
  });

  it('bundle refuses an existing file and leaves it alone (exit 1)', async () => {
    (jobBundleControllerDownload as jest.Mock).mockResolvedValue(new ArrayBuffer(1));
    mockWriteFile.mockRejectedValue(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));
    await run('bundle', 'j1');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('--force');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('bundle with no bundle yet writes nothing and exits 4', async () => {
    (jobBundleControllerDownload as jest.Mock).mockRejectedValue({ ret: 404, message: 'No bundle for this job' });
    await run('bundle', 'j1');
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(4);
  });
});
