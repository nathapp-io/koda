jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetReposControllerCreate: jest.fn(),
  fleetReposControllerRotateGitlabCredentials: jest.fn(),
  fleetReposControllerList: jest.fn(),
  fleetReposControllerRemove: jest.fn(),
  fleetReposControllerCheck: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));
jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import {
  fleetReposControllerCheck,
  fleetReposControllerRotateGitlabCredentials,
  fleetReposControllerCreate,
  fleetReposControllerList,
  fleetReposControllerRemove,
  projectFleetReposControllerList,
} from '../generated';
import { resolveContext } from '../config';
import { setJsonMode } from '../utils/json-mode';

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

  afterEach(() => {
    setJsonMode(false);
    jest.clearAllMocks();
  });

  it('add splits a GitLab subgroup path and sends the project slug in the body', async () => {
    const { readFile } = await import('node:fs/promises');
    (readFile as jest.Mock).mockResolvedValueOnce('r').mockResolvedValueOnce('w');
    (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: repo });
    await run('add', 'group/sub/svc', '--provider', 'gitlab', '--read-token-file', 'r', '--write-token-file', 'w');
    expect(fleetReposControllerCreate).toHaveBeenCalledWith({ body: { projectSlug: 'web', provider: 'gitlab', owner: 'group/sub', name: 'svc', readToken: 'r', writeToken: 'w' } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('add refuses a path without owner/name and an unknown provider (exit 3, no request)', async () => {
    setJsonMode(true);
    await run('add', 'svc', '--provider', 'github');
    expect(exitSpy).toHaveBeenCalledWith(3);
    const error = JSON.parse((console.error as jest.Mock).mock.calls[0][0]);
    expect(error.error).toMatchObject({ code: 'VALIDATION_ERROR', status: null });
    exitSpy.mockClear();
    await run('add', 'acme/app', '--provider', 'bitbucket');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetReposControllerCreate).not.toHaveBeenCalled();
  });

  it('add surfaces a forge refusal (422) as an API error, exit 1', async () => {
    (fleetReposControllerCreate as jest.Mock).mockRejectedValue({ ret: 422, message: 'Forge check failed: app_not_installed' });
    await run('add', 'acme/app', '--provider', 'github');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('AC-10 preserves the exact GitHub registration body', async () => {
    (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: repo });
    await run('add', 'owner/name', '--provider', 'github');
    expect(fleetReposControllerCreate).toHaveBeenCalledWith({ body: { projectSlug: 'web', provider: 'github', owner: 'owner', name: 'name' } });
  });

  it('AC-1 registers GitLab tokens and host from files, trimmed of a newline', async () => {
    const { readFile } = await import('node:fs/promises');
    (readFile as jest.Mock).mockResolvedValueOnce('read-secret\n').mockResolvedValueOnce('write-secret\n');
    (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: { ...repo, gitlab: null } });
    await run('add', 'group/app', '--provider', 'gitlab', '--host', 'https://gitlab.example.com', '--read-token-file', 'r.txt', '--write-token-file', 'w.txt');
    expect(fleetReposControllerCreate).toHaveBeenCalledWith({ body: { projectSlug: 'web', provider: 'gitlab', owner: 'group', name: 'app', host: 'https://gitlab.example.com', readToken: 'read-secret', writeToken: 'write-secret' } });
  });

  it('AC-2 reads a token from stdin when the file is -', async () => {
    const stdin = { async *[Symbol.asyncIterator]() { yield Buffer.from('stdin-token\n'); } };
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    try {
      const { readFile } = await import('node:fs/promises');
      (readFile as jest.Mock).mockResolvedValueOnce('write');
      (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: repo });
      await run('add', 'group/app', '--provider', 'gitlab', '--read-token-file', '-', '--write-token-file', 'w');
      expect(fleetReposControllerCreate).toHaveBeenCalledWith({ body: expect.objectContaining({ readToken: 'stdin-token', writeToken: 'write' }) });
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original);
    }
  });

  it('AC-5/6 warns to stderr but emits only the safe repo in JSON', async () => {
    const { readFile } = await import('node:fs/promises');
    (readFile as jest.Mock).mockResolvedValueOnce('r').mockResolvedValueOnce('w');
    const safeRepo = { ...repo, gitlab: { projectId: 42, readToken: { username: 'bot', expiresAt: null, status: 'ok' }, writeToken: { username: 'person', expiresAt: null, status: 'ok', isBot: false }, warnings: ['write_token_human'] } };
    (fleetReposControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: safeRepo });
    await run('add', 'group/app', '--provider', 'gitlab', '--read-token-file', 'r', '--write-token-file', 'w', '--json');
    expect((console.error as jest.Mock).mock.calls.flat().join(' ')).toContain('person');
    expect(logSpy.mock.calls.flat().join(' ')).toContain('"gitlab"');
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('secret');
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('AC-3/4 validates missing GitLab credentials and GitHub-only flags before requests', async () => {
    await run('add', 'group/app', '--provider', 'gitlab');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    await run('add', 'owner/name', '--provider', 'github', '--host', 'https://x');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect(fleetReposControllerCreate).not.toHaveBeenCalled();
  });

  it('AC-7 rotates only the supplied token and needs no project context', async () => {
    const { readFile } = await import('node:fs/promises');
    (readFile as jest.Mock).mockResolvedValueOnce('write-secret\n');
    (fleetReposControllerRotateGitlabCredentials as jest.Mock).mockResolvedValue({ ret: 0, data: repo });
    await run('credentials', 'fr1', '--write-token-file', 'w.txt');
    expect(fleetReposControllerRotateGitlabCredentials).toHaveBeenCalledWith({ path: { id: 'fr1' }, body: { writeToken: 'write-secret' } });
  });

  it('AC-8 refuses empty rotation and AC-9 names a missing token file without calling the API', async () => {
    const { readFile } = await import('node:fs/promises');
    await run('credentials', 'fr1');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    (readFile as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await run('credentials', 'fr1', '--read-token-file', 'missing-token.txt');
    expect(exitSpy).toHaveBeenLastCalledWith(3);
    expect((console.error as jest.Mock).mock.calls.flat().join(' ')).toContain('missing-token.txt');
    expect(fleetReposControllerRotateGitlabCredentials).not.toHaveBeenCalled();
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
