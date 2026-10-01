jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  runnersControllerList: jest.fn(),
  runnersControllerUpdate: jest.fn(),
  enrollmentsControllerCreate: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { enrollmentsControllerCreate, runnersControllerList, runnersControllerUpdate } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const runner = {
  id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: ['linux', 'gpu'], capacity: 2,
  capabilities: { nax: { version: '0.83.1' } }, daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b1',
  bootedAt: null, online: true, enabled: true, lastSeenAt: new Date().toISOString(), createdAt: '2026-10-01T00:00:00.000Z',
};
const page = { total: 1, current: 1, size: 100, hasNext: false, hasPrev: false, records: [runner] };

describe('koda fleet runner', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'runner', ...args]);
  const out = () => logSpy.mock.calls.flat().join('\n');

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

  it('list prints name, online, enabled, labels, capacity, nax version and boot age', async () => {
    (runnersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list');
    expect(runnersControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 100 } });
    expect(out()).toContain('box-1');
    expect(out()).toContain('linux,gpu');
    expect(out()).toContain('0.83.1');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('list prints - for a runner with no recorded boot', async () => {
    (runnersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list');
    const row = out().split('\n').find((l) => l.includes('box-1')) ?? '';
    expect(row).toMatch(/\s-(\s|$)/);
  });

  it('list --json prints the page', async () => {
    (runnersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list', '--json');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
  });

  it('a non-admin gets exit 2 and the admin-token hint', async () => {
    (runnersControllerList as jest.Mock).mockRejectedValue({ ret: 40003, message: 'Forbidden' });
    await run('list');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect((console.error as jest.Mock).mock.calls.flat().join('\n')).toContain('global-admin user access token');
  });

  it('an invalid API key keeps the API-key hint instead of the admin-token hint', async () => {
    (runnersControllerList as jest.Mock).mockRejectedValue({ ret: 40000, message: 'Unauthorized' });
    await run('list');
    expect(exitSpy).toHaveBeenCalledWith(2);
    const output = (console.error as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toContain('koda config set --api-key');
    expect(output).not.toContain('global-admin user access token');
  });

  it('enable and disable patch only enabled', async () => {
    (runnersControllerUpdate as jest.Mock).mockResolvedValue({ ret: 0, data: runner });
    await run('disable', 'r1');
    expect(runnersControllerUpdate).toHaveBeenCalledWith({ path: { id: 'r1' }, body: { enabled: false } });
    await run('enable', 'r1');
    expect(runnersControllerUpdate).toHaveBeenLastCalledWith({ path: { id: 'r1' }, body: { enabled: true } });
  });

  it('enroll-token sends labels and prints the token once with the enroll command line', async () => {
    (enrollmentsControllerCreate as jest.Mock).mockResolvedValue({
      ret: 0, data: { id: 'e1', labels: ['gpu', 'linux'], expiresAt: '2026-10-02T00:00:00.000Z', createdById: 'u', createdAt: '', token: 'ke_secret' },
    });
    await run('enroll-token', '--label', 'gpu', '--label', 'linux');
    expect(enrollmentsControllerCreate).toHaveBeenCalledWith({ body: { labels: ['gpu', 'linux'] } });
    expect(out()).toContain('ke_secret');
    expect(out()).toContain('koda-runner enroll --server https://koda.example.com --token ke_secret');
    expect(out()).toContain('2026-10-02T00:00:00.000Z');
  });

  it('enroll-token rejects a bad label before any request (exit 3)', async () => {
    await run('enroll-token', '--label', 'Bad Label');
    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(enrollmentsControllerCreate).not.toHaveBeenCalled();
  });
});
