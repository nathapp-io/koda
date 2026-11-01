jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetJobsControllerDispatch: jest.fn(),
  fleetJobsControllerList: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import {
  fleetJobsControllerDispatch,
  fleetJobsControllerList,
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const repo = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: ['gpu'], enabled: true, online: true, profiles: ['fast'] };
const page = <T>(records: T[]) => ({ ret: 0, data: { total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records } });

describe('koda fleet dispatch PR commands', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'dispatch', ...args]);

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([repo]));
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([box]));
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: { id: 'j1', state: 'QUEUED' }, placement: { assigned: false, runnerId: null, misfits: [] } } });
  });

  afterEach(() => jest.restoreAllMocks());

  it('dispatches FIX with profiles and no RUN-only fields', async () => {
    await run('--repo', 'acme/app', '--fix', '23', '--max-cost', '1', '--profile', 'native-codex');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({ path: { slug: 'web' }, body: {
      repoId: 'fr1', command: 'FIX', prNumber: 23, maxCostUsd: 1, profiles: ['native-codex'],
    } });
  });

  it('dispatches REVIEW with its exact body', async () => {
    await run('--repo', 'acme/app', '--review', '23', '--max-cost', '1');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({ path: { slug: 'web' }, body: {
      repoId: 'fr1', command: 'REVIEW', prNumber: 23, maxCostUsd: 1,
    } });
  });

  it('resolves --pin for FIX', async () => {
    await run('--repo', 'acme/app', '--fix', '23', '--max-cost', '1', '--pin', 'box-1');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ pinnedRunnerId: 'r1' }) }));
  });

  it('keeps the existing RUN body when --feature is provided', async () => {
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '1');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({ path: { slug: 'web' }, body: {
      repoId: 'fr1', command: 'RUN', feature: 'login', maxCostUsd: 1,
    } });
  });

  it('rejects a nonpositive PR number in Commander before dispatch', async () => {
    await expect(run('--repo', 'acme/app', '--fix', '0', '--max-cost', '1')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('looks up the canonical PR feature and reports an active-job conflict with exit 1', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'duplicate' });
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([{ id: 'j9', state: 'RUNNING', repoId: 'fr1', feature: 'review-pr-23' }]));
    await run('--repo', 'acme/app', '--fix', '23', '--max-cost', '1');
    expect(fleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { repoId: 'fr1', feature: 'review-pr-23', size: 20 } });
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('An active job already runs review-pr-23 on this repo: j9 (RUNNING)');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });
});
