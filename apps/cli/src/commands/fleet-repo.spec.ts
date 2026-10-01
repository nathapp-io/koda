jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetReposControllerCreate: jest.fn(),
  fleetReposControllerList: jest.fn(),
  fleetReposControllerRemove: jest.fn(),
  fleetReposControllerCheck: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import {
  fleetReposControllerCheck,
  fleetReposControllerCreate,
  fleetReposControllerList,
  fleetReposControllerRemove,
  projectFleetReposControllerList,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const repo = { id: 'fr1', projectId: 'p', provider: 'gitlab', owner: 'group/sub', name: 'svc', defaultBranch: 'main', githubInstallationId: null, createdAt: '' };
const page = { total: 1, current: 1, size: 100, hasNext: false, hasPrev: false, records: [repo] };

describe('koda fleet repo', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'repo', ...args]);

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

  it('add splits a GitLab subgroup path and sends the project slug in the body', async () => {
    (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: repo });
    await run('add', 'group/sub/svc', '--provider', 'gitlab');
    expect(fleetReposControllerCreate).toHaveBeenCalledWith({ body: { projectSlug: 'web', provider: 'gitlab', owner: 'group/sub', name: 'svc' } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('add refuses a path without owner/name and an unknown provider (exit 3, no request)', async () => {
    await run('add', 'svc', '--provider', 'github');
    expect(exitSpy).toHaveBeenCalledWith(3);
    await run('add', 'acme/app', '--provider', 'bitbucket');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetReposControllerCreate).not.toHaveBeenCalled();
  });

  it('add surfaces a forge refusal (422) as an API error, exit 1', async () => {
    (fleetReposControllerCreate as jest.Mock).mockRejectedValue({ ret: 422, message: 'Forge check failed: app_not_installed' });
    await run('add', 'acme/app', '--provider', 'github');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('list shows the project repos by default and the whole registry with --all', async () => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    (fleetReposControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await run('list');
    expect(projectFleetReposControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { current: 1, size: 100 } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('group/sub/svc');
    await run('list', '--all');
    expect(fleetReposControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 100 } });
  });

  it('rm needs --force and never calls the API without it', async () => {
    await run('rm', 'fr1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fleetReposControllerRemove).not.toHaveBeenCalled();
    (fleetReposControllerRemove as jest.Mock).mockResolvedValue(undefined);
    await run('rm', 'fr1', '--force');
    expect(fleetReposControllerRemove).toHaveBeenCalledWith({ path: { id: 'fr1' } });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('check prints reachable, or the reason and exits 1 when unreachable', async () => {
    (fleetReposControllerCheck as jest.Mock).mockResolvedValue({ ret: 0, data: { repoId: 'fr1', reachable: true, reason: null, checkedAt: '' } });
    await run('check', 'fr1');
    expect(fleetReposControllerCheck).toHaveBeenCalledWith({ path: { id: 'fr1' } });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
    (fleetReposControllerCheck as jest.Mock).mockResolvedValue({ ret: 0, data: { repoId: 'fr1', reachable: false, reason: 'app_not_installed', checkedAt: '' } });
    await run('check', 'fr1');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('app_not_installed');
    expect(exitSpy).toHaveBeenLastCalledWith(1);
  });
});
