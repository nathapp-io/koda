jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectFleetSchedulesControllerList: jest.fn(),
  projectFleetSchedulesControllerGet: jest.fn(),
  projectFleetSchedulesControllerCreate: jest.fn(),
  projectFleetSchedulesControllerUpdate: jest.fn(),
  projectFleetSchedulesControllerRemove: jest.fn(),
  projectFleetSchedulesControllerEnable: jest.fn(),
  projectFleetSchedulesControllerDisable: jest.fn(),
  fleetJobsControllerList: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { parseStallAfter, passedOf, scheduleState } from './fleet-schedule';
import {
  fleetJobsControllerList,
  projectFleetReposControllerList,
  projectFleetRunnersControllerList,
  projectFleetSchedulesControllerCreate,
  projectFleetSchedulesControllerDisable,
  projectFleetSchedulesControllerEnable,
  projectFleetSchedulesControllerGet,
  projectFleetSchedulesControllerList,
  projectFleetSchedulesControllerRemove,
  projectFleetSchedulesControllerUpdate,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'key', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', projectId: 'p', repoId: 'fr1', name: 'nightly', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', feature: 'login', ref: 'main',
  profiles: [], maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null, enabled: true, nextFireAt: '2026-10-03T01:00:00.000Z',
  bashMode: 'raw', approvalTimeoutSec: 600,
  lastFiredAt: null, lastJobId: null, lastPassedCount: 0, noProgressTicks: 0, noProgressLimit: 3, disabledReason: null, totalCostUsd: '0.0000',
  createdById: 'u', updatedById: 'u', createdAt: '', updatedAt: '', ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });
const REPOS = ok({ total: 1, current: 1, size: 100, hasNext: false, records: [{ id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main' }] });
const RUNNERS = ok({ total: 1, current: 1, size: 100, hasNext: false, records: [{ id: 'run-1', name: 'box-1', online: true }] });

describe('koda fleet schedule', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'schedule', ...args]);
  const out = () => logSpy.mock.calls.flat().join('\n');

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(REPOS);
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(RUNNERS);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses the stall limit and labels the state', () => {
    expect(parseStallAfter('5')).toBe(5);
    expect(() => parseStallAfter('0')).toThrow();
    expect(() => parseStallAfter('21')).toThrow();
    expect(() => parseStallAfter('x')).toThrow();
    expect(scheduleState(row() as never)).toBe('enabled');
    expect(scheduleState(row({ enabled: false, disabledReason: 'no_progress' }) as never)).toBe('disabled (no_progress)');
    expect(passedOf({ progress: { passed: 2, total: 5 } } as never)).toBe('2/5');
    expect(passedOf({ progress: null } as never)).toBe('-');
  });

  it('list prints repo names and the disabled reason; --json prints the rows', async () => {
    (projectFleetSchedulesControllerList as jest.Mock).mockResolvedValue(ok([row(), row({ id: 's2', enabled: false, disabledReason: 'completed', nextFireAt: null })]));
    await run('list');
    expect(projectFleetSchedulesControllerList).toHaveBeenCalledWith({ path: { slug: 'web' } });
    expect(out()).toContain('acme/app');
    expect(out()).toContain('disabled (completed)');
    logSpy.mockClear();
    await run('list', '--json');
    expect(JSON.parse(out())).toHaveLength(2);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('add resolves the repo and sends only what was given', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--timezone', 'Asia/Singapore', '--max-cost', '5');
    expect(projectFleetSchedulesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: { name: 'login', repoId: 'fr1', feature: 'login', cron: '0 9 * * 1-5', timezone: 'Asia/Singapore', maxCostUsd: 5 },
    });
    expect(out()).toContain('s1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('add requires --timezone: commander errors and nothing is sent (no machine-zone or UTC default)', async () => {
    await expect(run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--max-cost', '5'))
      .rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
    expect(projectFleetSchedulesControllerCreate).not.toHaveBeenCalled();
  });

  it('add passes name, zone, ref, profiles, labels and the stall limit; --pin resolves a runner name', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run(
      'add', '--repo', 'fr1', '--feature', 'login', '--cron', '0 9 * * *', '--max-cost', '2.5', '--name', 'morning', '--timezone', 'UTC', '--ref', 'dev',
      '--profile', 'fast', '--profile', 'slow', '--pin', 'box-1', '--stall-after', '5',
    );
    expect(projectFleetSchedulesControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'web' },
      body: {
        name: 'morning', repoId: 'fr1', feature: 'login', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 2.5, ref: 'dev', profiles: ['fast', 'slow'],
        pinnedRunnerId: 'run-1', noProgressLimit: 5,
      },
    });
  });

  it('add refuses --pin with --label, an unknown repo and an unknown runner before any create (exit 3)', async () => {
    await run('add', '--repo', 'acme/app', '--feature', 'f', '--cron', '0 9 * * *', '--timezone', 'UTC', '--max-cost', '1', '--pin', 'box-1', '--label', 'linux');
    await run('add', '--repo', 'nope/none', '--feature', 'f', '--cron', '0 9 * * *', '--timezone', 'UTC', '--max-cost', '1');
    await run('add', '--repo', 'acme/app', '--feature', 'f', '--cron', '0 9 * * *', '--timezone', 'UTC', '--max-cost', '1', '--pin', 'ghost');
    expect(projectFleetSchedulesControllerCreate).not.toHaveBeenCalled();
    expect(exitSpy.mock.calls.filter((c) => c[0] === 3)).toHaveLength(3);
  });

  it('add and edit pass --bash-mode and --approval-timeout (D301)', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--timezone', 'UTC', '--max-cost', '5', '--bash-mode', 'gated', '--approval-timeout', '120');
    expect(projectFleetSchedulesControllerCreate).toHaveBeenLastCalledWith({
      path: { slug: 'web' },
      body: { name: 'login', repoId: 'fr1', feature: 'login', cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5, bashMode: 'gated', approvalTimeoutSec: 120 },
    });
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockResolvedValue(ok(row()));
    (projectFleetSchedulesControllerGet as jest.Mock).mockResolvedValue(ok(row({ bashMode: 'gated', approvalTimeoutSec: 120 })));
    await run('edit', 's1', '--approval-timeout', '300');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { approvalTimeoutSec: 300 } });
    await run('edit', 's1', '--bash-mode', 'raw');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { bashMode: 'raw' } });
  });

  it('edit refuses a timeout without a relay mode on a raw schedule (D301, exit 3)', async () => {
    (projectFleetSchedulesControllerGet as jest.Mock).mockResolvedValue(ok(row({ bashMode: 'raw' })));
    await run('edit', 's1', '--approval-timeout', '300');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(projectFleetSchedulesControllerUpdate).not.toHaveBeenCalled();
  });

  it('edit refuses --bash-mode raw with --approval-timeout without fetching the stored mode (D301, exit 3)', async () => {
    await run('edit', 's1', '--bash-mode', 'raw', '--approval-timeout', '300');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(projectFleetSchedulesControllerGet).not.toHaveBeenCalled();
    expect(projectFleetSchedulesControllerUpdate).not.toHaveBeenCalled();
  });

  it('edit accepts --bash-mode gated with --approval-timeout without fetching the stored mode (D301)', async () => {
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockResolvedValue(ok(row()));
    await run('edit', 's1', '--bash-mode', 'gated', '--approval-timeout', '90');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { bashMode: 'gated', approvalTimeoutSec: 90 } });
    expect(projectFleetSchedulesControllerGet).not.toHaveBeenCalled();
  });

  it('add refuses a timeout without a relay mode (exit 3)', async () => {
    await run('add', '--repo', 'acme/app', '--feature', 'login', '--cron', '0 9 * * 1-5', '--timezone', 'UTC', '--max-cost', '5', '--approval-timeout', '120');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(projectFleetSchedulesControllerCreate).not.toHaveBeenCalled();
  });

  it('add maps an API 400 (cron too frequent) to exit 3', async () => {
    (projectFleetSchedulesControllerCreate as jest.Mock).mockRejectedValue({ ret: -2, status: 400, message: 'The schedule fires more often than every 15 minutes' });
    await run('add', '--repo', 'acme/app', '--feature', 'f', '--cron', '*/10 * * * *', '--timezone', 'UTC', '--max-cost', '1');
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('edit sends only the changed fields; --unpin sends null; --clear-labels sends []', async () => {
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockResolvedValue(ok(row()));
    await run('edit', 's1', '--cron', '0 6 * * *', '--max-cost', '3');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { cron: '0 6 * * *', maxCostUsd: 3 } });
    await run('edit', 's1', '--unpin', '--clear-labels', '--clear-profiles');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({ path: { slug: 'web', id: 's1' }, body: { pinnedRunnerId: null, selectorLabels: [], profiles: [] } });
    await run('edit', 's1', '--profile', 'fast', '--pin', 'box-1', '--stall-after', '4');
    expect(projectFleetSchedulesControllerUpdate).toHaveBeenLastCalledWith({
      path: { slug: 'web', id: 's1' }, body: { profiles: ['fast'], pinnedRunnerId: 'run-1', noProgressLimit: 4 },
    });
  });

  it('edit with nothing to change, or --pin with --unpin, is a validation error', async () => {
    await run('edit', 's1');
    await run('edit', 's1', '--pin', 'box-1', '--unpin');
    expect(projectFleetSchedulesControllerUpdate).not.toHaveBeenCalled();
    expect(exitSpy.mock.calls.filter((c) => c[0] === 3)).toHaveLength(2);
  });

  it('show prints the schedule and its last jobs through the job list filter', async () => {
    (projectFleetSchedulesControllerGet as jest.Mock).mockResolvedValue(ok(row({ lastPassedCount: 3 })));
    (fleetJobsControllerList as jest.Mock).mockResolvedValue(ok({
      total: 1, current: 1, size: 10, hasNext: false,
      records: [{ id: 'j1', state: 'FAILED', progress: { passed: 3, total: 5 }, costSpentUsd: '1.2000', coalescedCount: 2, wipPush: 'pushed', stateReason: null }],
    }));
    await run('show', 's1');
    expect(projectFleetSchedulesControllerGet).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
    expect(fleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { scheduleId: 's1', size: 10 } });
    expect(out()).toContain('3/5');
    expect(out()).toContain('pushed');
    expect(out()).toContain('bash raw');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('enable and disable call their routes; rm needs --force', async () => {
    (projectFleetSchedulesControllerEnable as jest.Mock).mockResolvedValue(ok(row()));
    (projectFleetSchedulesControllerDisable as jest.Mock).mockResolvedValue(ok(row({ enabled: false, disabledReason: 'manual', nextFireAt: null })));
    await run('enable', 's1');
    expect(projectFleetSchedulesControllerEnable).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
    await run('disable', 's1');
    expect(projectFleetSchedulesControllerDisable).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
    await run('rm', 's1');
    expect(projectFleetSchedulesControllerRemove).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    (projectFleetSchedulesControllerRemove as jest.Mock).mockResolvedValue(undefined);
    await run('rm', 's1', '--force');
    expect(projectFleetSchedulesControllerRemove).toHaveBeenCalledWith({ path: { slug: 'web', id: 's1' } });
  });

  it('enable maps the 409 for an owner without access to exit 1 and prints the API message (plan D211)', async () => {
    (projectFleetSchedulesControllerEnable as jest.Mock).mockRejectedValue({ ret: 409, message: "The schedule's owner can no longer dispatch to this project" });
    const errSpy = jest.spyOn(console, 'error');
    await run('enable', 's1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('owner can no longer dispatch');
  });

  it('a 403 from edit (not the owner) exits 2, the CLI\'s auth-error code', async () => {
    (projectFleetSchedulesControllerUpdate as jest.Mock).mockRejectedValue({ statusCode: 403, message: 'Forbidden' });
    await run('edit', 's1', '--cron', '0 6 * * *');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
