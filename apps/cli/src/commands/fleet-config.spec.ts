jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectRepoConfigControllerList: jest.fn(),
  projectRepoConfigControllerSubmitDrift: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { projectRepoConfigControllerList, projectRepoConfigControllerSubmitDrift } from '../generated';
import { resolveContext } from '../config';
import { setJsonMode } from '../utils/json-mode';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const list = {
  baseSha: 'abc123def4567890', defaultBranch: 'main',
  files: [{ path: '.nax/context.md', size: 1200, blobSha: 'b1', group: 'context' }, { path: '.nax/rules/a.md', size: 80, blobSha: 'b2', group: 'rules' }],
};

describe('koda fleet nax-files / drift-check (S3 §7)', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    // withContext passes the flags straight to resolveContext; honor --project.
    (resolveContext as jest.Mock).mockImplementation(async (flags: { projectSlug?: string }) => ({
      ...CTX,
      projectSlug: flags.projectSlug ?? CTX.projectSlug,
    }));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setJsonMode(false);
    jest.clearAllMocks();
  });

  it('nax-files lists the files of the repo in the context project', async () => {
    (projectRepoConfigControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: list });
    await run('nax-files', 'fr1');
    expect(projectRepoConfigControllerList).toHaveBeenCalledWith({ path: { slug: 'web', repoId: 'fr1' } });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('.nax/context.md');
    expect(out).toContain('main @ abc123def456');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('nax-files --json prints the raw list', async () => {
    (projectRepoConfigControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: list });
    await run('nax-files', 'fr1', '--json');
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual(list);
  });

  it('drift-check queues a job and prints its id', async () => {
    (projectRepoConfigControllerSubmitDrift as jest.Mock).mockResolvedValue({
      ret: 0, data: { job: { id: 'job-9', state: 'QUEUED' }, placement: { assigned: true, runnerId: 'rn1', misfits: [] } },
    });
    await run('drift-check', 'fr1', '--project', 'other');
    expect(projectRepoConfigControllerSubmitDrift).toHaveBeenCalledWith({ path: { slug: 'other', repoId: 'fr1' } });
    expect(logSpy.mock.calls[0][0]).toContain('job-9');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('drift-check surfaces a 409 (a config job is already active) as an API error, exit 1', async () => {
    (projectRepoConfigControllerSubmitDrift as jest.Mock).mockRejectedValue({ ret: 409, message: 'A config job is already active: job-1' });
    await run('drift-check', 'fr1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
