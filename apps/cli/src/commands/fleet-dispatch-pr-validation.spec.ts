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
const page = <T>(records: T[]) => ({ ret: 0, data: { total: records.length, current: 1, size: 100, hasNext: false, hasPrev: false, records } });
const BASE = ['--repo', 'acme/app', '--max-cost', '1'];

describe('koda fleet dispatch PR validation', () => {
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
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([]));
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([]));
  });

  afterEach(() => jest.restoreAllMocks());

  async function expectInvalid(args: string[], expected: string): Promise<void> {
    await run(...BASE, ...args);
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(expected);
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
    expect(projectFleetReposControllerList).not.toHaveBeenCalled();
    expect(projectFleetRunnersControllerList).not.toHaveBeenCalled();
    expect(fleetJobsControllerList).not.toHaveBeenCalled();
  }

  it('rejects simultaneous --review and --fix before any request', async () => {
    await expectInvalid(['--review', '23', '--fix', '23'], 'Use --review or --fix, not both');
  });

  it.each([
    ['--feature', 'login'], ['--plan', 'plan.md'], ['--ref', 'dev'], ['--ticket', 'KD-1'],
    ['--bash-mode', 'raw'], ['--approval-timeout', '60'],
  ])('rejects --fix with incompatible flag %s before any request', async (...flag) => {
    await expectInvalid(['--fix', '23', ...flag], '--feature, --plan, --ref, --ticket, --bash-mode and --approval-timeout are not for --review or --fix');
  });

  it.each([
    ['--review', '23', '--feature', 'login'], ['--review', '23', '--plan', 'plan.md'],
    ['--review', '23', '--ref', 'dev'], ['--review', '23', '--ticket', 'KD-1'],
    ['--review', '23', '--bash-mode', 'raw'], ['--review', '23', '--approval-timeout', '60'],
    ['--fix', '23', '--feature', 'login'], ['--fix', '23', '--plan', 'plan.md'],
    ['--fix', '23', '--ref', 'dev'], ['--fix', '23', '--ticket', 'KD-1'],
    ['--fix', '23', '--bash-mode', 'gated'], ['--fix', '23', '--approval-timeout', '60'],
  ])('rejects PR command with RUN/PLAN-only flags %j before any request', async (...args) => {
    await expectInvalid(args, '--feature, --plan, --ref, --ticket, --bash-mode and --approval-timeout are not for --review or --fix');
  });

  it('rejects missing feature when no PR command is selected before any request', async () => {
    await expectInvalid([], '--feature is required unless --review or --fix is given');
  });

  it('rejects an approval timeout without a bash mode after PR checks', async () => {
    await expectInvalid(['--feature', 'login', '--approval-timeout', '60'], '--approval-timeout needs --bash-mode gated or escalate');
  });

  it.each([
    ['--review', '23', '--fix', '23'],
    ['--fix', '23', '--feature', 'login'],
    ['--fix', '23', '--ref', 'dev'],
    ['--fix', '23', '--bash-mode', 'gated'],
    ['--review', '23', '--plan', 'plan.md'],
    ['--review', '23', '--ticket', 'KD-1'],
    ['--review', '23', '--bash-mode', 'raw'],
    ['--review', '23', '--approval-timeout', '60'],
  ])('makes zero fleet API calls for invalid arguments %j', async (...args) => {
    await run(...BASE, ...args);
    expect(fleetJobsControllerDispatch).not.toHaveBeenCalled();
    expect(fleetJobsControllerList).not.toHaveBeenCalled();
    expect(projectFleetReposControllerList).not.toHaveBeenCalled();
    expect(projectFleetRunnersControllerList).not.toHaveBeenCalled();
  });
});
