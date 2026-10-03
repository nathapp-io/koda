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
import { setJsonMode } from '../utils/json-mode';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const repo = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: ['gpu'], enabled: true, online: true, profiles: ['fast'] };
const job = (over = {}) => ({ id: 'j1', state: 'ASSIGNED', repoId: 'fr1', feature: 'login', ...over });
const page = <T>(records: T[]) => ({ ret: 0, data: { total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records } });

describe('koda fleet dispatch', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const run = (...a: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'dispatch', ...a]);

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
  });

  afterEach(() => {
    setJsonMode(false);
    jest.clearAllMocks();
  });

  it('dispatches a RUN by repo name with profiles and labels, and prints the assigned runner', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: true, runnerId: 'r1', misfits: [] } } });
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5', '--profile', 'fast', '--profile', 'cheap', '--label', 'gpu');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { repoId: 'fr1', command: 'RUN', feature: 'login', maxCostUsd: 5, profiles: ['fast', 'cheap'], selectorLabels: ['gpu'] },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Assigned to box-1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('dispatches a PLAN when --plan is given, pinned by runner name, with a ref', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job({ state: 'QUEUED' }), placement: { assigned: false, runnerId: null, misfits: [{ runnerId: 'r1', name: 'box-1', reason: 'offline' }] } } });
    await run('--repo', 'fr1', '--feature', 'login', '--max-cost', '1', '--plan', 'docs/spec.md', '--pin', 'box-1', '--ref', 'dev');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { repoId: 'fr1', command: 'PLAN', feature: 'login', maxCostUsd: 1, planFrom: 'docs/spec.md', pinnedRunnerId: 'r1', ref: 'dev' },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('offline');
  });

  it('still prints the job and exits 0 when the runner-name lookup fails after dispatch', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: true, runnerId: 'r1', misfits: [] } } });
    (projectFleetRunnersControllerList as jest.Mock).mockRejectedValue(new Error('network down'));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Job j1 ASSIGNED');
    expect(out).toContain('Assigned to r1');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('refuses --label with --pin, an unknown repo and an unknown runner before dispatching (exit 3)', async () => {
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--label', 'gpu', '--pin', 'box-1');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('--repo', 'acme/nope', '--feature', 'f', '--max-cost', '1');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--pin', 'ghost');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('rejects a bad --max-cost before any request', async () => {
    await expect(run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '0')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('sends --bash-mode and --approval-timeout on a RUN (D301)', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: true, runnerId: 'r1', misfits: [] } } });
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5', '--bash-mode', 'escalate', '--approval-timeout', '900');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { repoId: 'fr1', command: 'RUN', feature: 'login', maxCostUsd: 5, bashMode: 'escalate', approvalTimeoutSec: 900 },
    });
  });

  // One `it` per case: commander 12 keeps option values across parseAsync calls on one program, and `dispatch` has no
  // option reset, so a second run in the same test would inherit --plan / --bash-mode from the first.
  it.each([
    ['a relay mode on a PLAN', ['--plan', 'docs/s.md', '--bash-mode', 'gated'], '--plan job stays raw'],
    ['a timeout without a mode', ['--approval-timeout', '60'], '--approval-timeout needs'],
    ['a timeout with raw', ['--bash-mode', 'raw', '--approval-timeout', '60'], '--approval-timeout needs'],
  ])('refuses %s before dispatching (exit 3)', async (_name, extra, message) => {
    await run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', ...extra);
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(message);
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('rejects a bad --bash-mode or --approval-timeout before any request', async () => {
    await expect(run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--bash-mode', 'loud')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    await expect(run('--repo', 'acme/app', '--feature', 'f', '--max-cost', '1', '--approval-timeout', '5')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
  });

  it('on a duplicate (409) names the active job and exits 1', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'An active job already runs this feature: j0' });
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job({ id: 'j9', state: 'COMPLETED' }), job({ id: 'j0', state: 'RUNNING' })]));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect(fleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { repoId: 'fr1', feature: 'login', size: 20 } });
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('j0');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('emits a duplicate-job conflict as one structured JSON error', async () => {
    setJsonMode(true);
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'duplicate' });
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job({ state: 'RUNNING' })]));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5', '--json');
    expect(JSON.parse(errorSpy.mock.calls.flat().join('\n'))).toEqual({ error: {
      code: 'API_ERROR',
      message: 'An active job already runs login on this repo: j1 (RUNNING). koda fleet job show j1',
      status: 409,
      hint: null,
    } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenLastCalledWith(1);
    setJsonMode(false);
  });

  it('on a 409 whose job already finished, falls back to the API message', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'An active job already runs this feature: j0' });
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(page([job({ id: 'j0', state: 'COMPLETED' })]));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('An active job already runs this feature');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });

  it('on a 409 whose lookup fails, still reports the original conflict', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockRejectedValue({ ret: 409, message: 'An active job already runs this feature: j0' });
    (fleetJobsControllerList as jest.Mock).mockRejectedValue(new Error('network down'));
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('An active job already runs this feature');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });
});
