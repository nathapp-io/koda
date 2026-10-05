jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetDashboardControllerGet: jest.fn(),
  projectFleetDashboardControllerGet: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { describeAttention, secText } from './fleet-status';
import { fleetDashboardControllerGet, projectFleetDashboardControllerGet, type AttentionItemDto } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const ok = (data: unknown) => ({ ret: 0, data });
const item = (over: Partial<AttentionItemDto>): AttentionItemDto => ({
  key: 'job_silent:j1', kind: 'job_silent', severity: 'error', subjectType: 'job', subjectId: 'j1', subjectName: 'add-auth',
  projectSlug: 'web', since: new Date(Date.now() - 200_000).toISOString(), ...over,
} as AttentionItemDto);
const snapshot = (attention: AttentionItemDto[] = []) => ({
  generatedAt: new Date().toISOString(),
  counts: { runnersOnline: 2, runnersTotal: 3, queued: 1, running: 2, attention: attention.length },
  runners: [], activeJobs: [], activeTruncated: false, recentJobs: [], recentTruncated: false, attention,
});

describe('koda fleet status', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const out = () => logSpy.mock.calls.flat().join('\n');
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'status', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('uses the project route by default and prints the counts and All clear', async () => {
    (projectFleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot()));
    await run();
    expect(projectFleetDashboardControllerGet).toHaveBeenCalledWith({ path: { slug: 'web' } });
    expect(out()).toContain('runners 2/3 online · queued 1 · running 2 · attention 0');
    expect(out()).toContain('All clear');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('uses the admin route with --all-projects and lists attention items', async () => {
    (fleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot([item({ stage: 'running', silentSec: 200, runnerName: 'wk-mac' })])));
    await run('--all-projects');
    expect(fleetDashboardControllerGet).toHaveBeenCalled();
    expect(projectFleetDashboardControllerGet).not.toHaveBeenCalled();
    expect(out()).toContain('No heartbeat for 3m 20s on wk-mac');
    expect(out()).toContain('add-auth');
  });

  it('refuses --all-projects with --project before calling the API', async () => {
    await run('--all-projects', '--project', 'web');
    expect(fleetDashboardControllerGet).not.toHaveBeenCalled();
    expect(projectFleetDashboardControllerGet).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it('prints the admin-token hint and exits 2 when --all-projects is refused', async () => {
    (fleetDashboardControllerGet as jest.Mock).mockRejectedValue({ statusCode: 403, message: 'Forbidden' });
    await run('--all-projects');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect((console.error as jest.Mock).mock.calls.flat().join('\n')).toContain('global-admin');
  });

  it('prints the DTO unchanged with --json', async () => {
    (projectFleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot()));
    await run('--json');
    expect(JSON.parse(out())).toMatchObject({ counts: { runnersTotal: 3 }, attention: [] });
  });

  it('escapes control characters in names coming from the API', async () => {
    (projectFleetDashboardControllerGet as jest.Mock).mockResolvedValue(ok(snapshot([item({ subjectName: 'evil\u001b[2J', stage: 'running', silentSec: 5, runnerName: 'r\u0007' })])));
    await run();
    expect(out()).not.toContain('\u001b');
    expect(out()).not.toContain('\u0007');
    expect(out()).toContain('evil\\x1b[2J');
  });
});

describe('describeAttention', () => {
  it.each([
    [item({ stage: 'starting', silentSec: 360, runnerName: 'wk-mac' }), 'Assigned to wk-mac 6m 0s ago, not started'],
    [item({ kind: 'job_waiting_approval', pending: 2, oldestSec: 190 }), '2 approval(s) pending, oldest 3m 10s'],
    [item({ kind: 'job_unplaceable', verdict: 'no_fit', reasons: [{ runnerName: 'a', reason: 'offline' }], reasonsTotal: 3 }), 'No runner fits: a offline (+2 more)'],
    [item({ kind: 'job_unplaceable', verdict: 'never', reasons: [{ runnerName: 'a', reason: 'disabled' }], reasonsTotal: 1 }), 'No runner can ever run this: a disabled'],
    [item({ kind: 'job_unplaceable', verdict: 'budget_paused' }), 'Budget paused; this job will be cancelled'],
    [item({ kind: 'job_unplaceable', verdict: 'runners_paused' }), 'Every runner is budget-paused'],
    [item({ kind: 'job_unplaceable', verdict: 'waiting_capacity' }), 'Waiting for a free runner'],
    [item({ kind: 'job_unplaceable', verdict: 'no_runners' }), 'No runner can take this job'],
    [item({ kind: 'job_unplaceable', verdict: 'fits_not_placed' }), 'A runner fits but the job has not been placed'],
    [item({ kind: 'runner_unhealthy', subjectType: 'runner', conditions: [
      { type: 'offline', jobsHeld: 1 }, { type: 'credential', providerId: 'deepseek', why: 'unavailable' }, { type: 'stale_nax', version: '0.82.0', latest: '0.83.0' },
    ] }), 'offline, holding 1 job(s); credential deepseek unavailable; nax 0.82.0 behind 0.83.0'],
    [item({ kind: 'runner_unhealthy', subjectType: 'runner', conditions: [{ type: 'offline', jobsHeld: 0 }, { type: 'configuration' }] }), 'offline; configuration problem'],
  ])('words %#', (a, text) => {
    expect(describeAttention(a)).toBe(text);
  });

  it('formats durations', () => {
    expect([secText(42), secText(190), secText(7260), secText(undefined)]).toEqual(['42s', '3m 10s', '2h 1m', '0s']);
  });
});
