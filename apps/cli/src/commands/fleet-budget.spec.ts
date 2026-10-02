jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetBudgetsControllerList: jest.fn(),
  fleetBudgetsControllerCreate: jest.fn(),
  fleetBudgetsControllerUpdate: jest.fn(),
  fleetBudgetsControllerRemove: jest.fn(),
  fleetBudgetsControllerResume: jest.fn(),
  projectFleetBudgetsControllerList: jest.fn(),
  projectFleetBudgetsControllerCreate: jest.fn(),
  projectFleetBudgetsControllerUpdate: jest.fn(),
  projectFleetBudgetsControllerRemove: jest.fn(),
  projectFleetBudgetsControllerResume: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { budgetState, parseScope, parseWarn } from './fleet-budget';
import {
  fleetBudgetsControllerCreate,
  fleetBudgetsControllerList,
  fleetBudgetsControllerRemove,
  fleetBudgetsControllerUpdate,
  projectFleetBudgetsControllerCreate,
  projectFleetBudgetsControllerList,
  projectFleetBudgetsControllerResume,
  projectFleetReposControllerList,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1', scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '50', warnPercent: 80,
  hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null, windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '12.5',
  warnReached: false, updatedById: 'u', createdAt: '', updatedAt: '', ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });

describe('koda fleet budget', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'budget', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses scopes and warn values', () => {
    expect(parseScope('global')).toEqual({ scopeType: 'global' });
    expect(parseScope('repo:acme/app')).toEqual({ scopeType: 'repo', ref: 'acme/app' });
    expect(() => parseScope('runner:')).toThrow();
    expect(() => parseScope('team')).toThrow();
    expect(parseWarn('none')).toBe('none');
    expect(parseWarn('75')).toBe(75);
    expect(() => parseWarn('0')).toThrow();
    expect(() => parseWarn('100')).toThrow();
    expect(budgetState(row({ paused: true, warnReached: true }) as never)).toBe('PAUSED');
    expect(budgetState(row({ warnReached: true }) as never)).toBe('WARN');
  });

  it('list uses the admin route without --project and the project route with it', async () => {
    (fleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([row({ paused: true })]));
    (projectFleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([]));
    await run('list');
    expect(fleetBudgetsControllerList).toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('PAUSED');
    await run('list', '--project', 'web');
    expect(projectFleetBudgetsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' } });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('set creates a global policy on the admin route, sending only what was given', async () => {
    (fleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([]));
    (fleetBudgetsControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run('set', '--scope', 'global', '--window', 'month', '--amount', '50');
    expect(fleetBudgetsControllerCreate).toHaveBeenCalledWith({ body: { scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 50 } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('set updates the existing policy for the same scope and window', async () => {
    (fleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([row({ id: 'r1', scopeType: 'runner', scopeId: 'run-1' }), row({ id: 'g1' })]));
    (fleetBudgetsControllerUpdate as jest.Mock).mockResolvedValue(ok(row({ id: 'r1' })));
    await run('set', '--scope', 'runner:run-1', '--window', 'month', '--amount', '20', '--warn', 'none', '--hard-stop', 'off', '--running', 'cancel');
    expect(fleetBudgetsControllerUpdate).toHaveBeenCalledWith({
      path: { id: 'r1' }, body: { amountUsd: 20, warnPercent: null, hardStop: false, runningJobs: 'cancel' },
    });
  });

  it('set resolves a repo by owner/name on the project route', async () => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(ok({
      total: 1, current: 1, size: 100, hasNext: false, records: [{ id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main' }],
    }));
    (projectFleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([]));
    (projectFleetBudgetsControllerCreate as jest.Mock).mockResolvedValue(ok(row({ scopeType: 'repo', scopeId: 'fr1' })));
    await run('set', '--scope', 'repo:acme/app', '--window', 'lifetime', '--amount', '5', '--project', 'web');
    expect(projectFleetBudgetsControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'web' }, body: { scopeType: 'repo', scopeId: 'fr1', windowKind: 'lifetime', amountUsd: 5 },
    });
  });

  it('set refuses a bad scope before any request', async () => {
    await expect(run('set', '--scope', 'team', '--window', 'month', '--amount', '5')).rejects.toThrow();
    expect(fleetBudgetsControllerList).not.toHaveBeenCalled();
  });

  it('rm needs --force; resume sends the new amount on the project route', async () => {
    await run('rm', 'b1');
    expect(fleetBudgetsControllerRemove).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    (fleetBudgetsControllerRemove as jest.Mock).mockResolvedValue(undefined);
    await run('rm', 'b1', '--force');
    expect(fleetBudgetsControllerRemove).toHaveBeenCalledWith({ path: { id: 'b1' } });
    (projectFleetBudgetsControllerResume as jest.Mock).mockResolvedValue(ok(row({ amountUsd: '80' })));
    await run('resume', 'b2', '--project', 'web', '--amount', '80');
    expect(projectFleetBudgetsControllerResume).toHaveBeenCalledWith({ path: { slug: 'web', id: 'b2' }, body: { amountUsd: 80 } });
  });

  it('surfaces a refused resume (400) as a validation error, exit 3', async () => {
    (projectFleetBudgetsControllerResume as jest.Mock).mockRejectedValue({ ret: -2, status: 400, message: 'The amount 5 must be above this window\'s spend of 9' });
    await run('resume', 'b2', '--project', 'web');
    expect(projectFleetBudgetsControllerResume).toHaveBeenCalledWith({ path: { slug: 'web', id: 'b2' }, body: {} });
    expect(exitSpy).toHaveBeenCalledWith(3);
  });
});
