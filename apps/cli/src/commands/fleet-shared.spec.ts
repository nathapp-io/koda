jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
jest.mock('../generated', () => ({
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));

import { projectFleetReposControllerList, projectFleetRunnersControllerList } from '../generated';
import { setJsonMode } from '../utils/json-mode';
import { ago, handleFleetError, pageHint, printPlacement, resolveRepo, resolveRunner, runnerNames, splitRepoPath } from './fleet-shared';

const ok = <T>(data: T) => ({ ret: 0, data });
const page = <T>(records: T[], current = 1, hasNext = false) => ok({ total: records.length, current, size: 100, hasNext, hasPrev: current > 1, records });
const repoA = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const repoB = { id: 'fr2', projectId: 'p', provider: 'gitlab', owner: 'group/sub', name: 'svc', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true, profiles: [] };

describe('fleet-shared', () => {
  afterEach(() => {
    setJsonMode(false);
    jest.clearAllMocks();
  });

  it('ago prints a compact age and - for no value', () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    expect(ago(null, now)).toBe('-');
    expect(ago(undefined, now)).toBe('-');
    expect(ago('2026-10-01T11:59:18.000Z', now)).toBe('42s');
    expect(ago('2026-10-01T11:55:00.000Z', now)).toBe('5m');
    expect(ago('2026-10-01T09:00:00.000Z', now)).toBe('3h');
    expect(ago('2026-09-29T12:00:00.000Z', now)).toBe('2d');
    expect(ago('2026-10-01T12:00:05.000Z', now)).toBe('0s');
    expect(ago('not a date', now)).toBe('-');
  });

  it('pageHint names the next page only when there is one', () => {
    expect(pageHint({ total: 3, current: 1, size: 2, hasNext: true, records: [] })).toBe('Next: --page 2');
    expect(pageHint({ total: 1, current: 1, size: 2, hasNext: false, records: [] })).toBeNull();
  });

  it('splitRepoPath keeps GitLab subgroups in the owner', () => {
    expect(splitRepoPath('acme/app')).toEqual({ owner: 'acme', name: 'app' });
    expect(splitRepoPath('group/sub/app')).toEqual({ owner: 'group/sub', name: 'app' });
    for (const bad of ['app', '/app', 'acme/', '', 'a//b']) expect(splitRepoPath(bad)).toBeNull();
  });

  it('resolveRepo matches an id or owner/name case-insensitively, including subgroups', async () => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(page([repoA, repoB]));
    expect(await resolveRepo('web', 'fr2')).toEqual(repoB);
    expect(await resolveRepo('web', 'ACME/App')).toEqual(repoA);
    expect(await resolveRepo('web', 'group/sub/svc')).toEqual(repoB);
    expect(await resolveRepo('web', 'acme/other')).toBeNull();
    expect(projectFleetReposControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { size: 100 } });
  });

  it.each(['fr2', 'GROUP/SUB/SVC'])('resolves a repo by id or path on a later page (%s)', async (ref) => {
    (projectFleetReposControllerList as jest.Mock)
      .mockResolvedValueOnce(page([repoA], 1, true))
      .mockResolvedValueOnce(page([repoB], 2));
    expect(await resolveRepo('web', ref)).toEqual(repoB);
    expect(projectFleetReposControllerList).toHaveBeenNthCalledWith(2, { path: { slug: 'web' }, query: { size: 100, current: 2 } });
  });

  it('resolveRunner matches an id or a name; runnerNames maps id to name', async () => {
    (projectFleetRunnersControllerList as jest.Mock).mockResolvedValue(page([box]));
    expect(await resolveRunner('web', 'box-1')).toEqual(box);
    expect(await resolveRunner('web', 'r1')).toEqual(box);
    expect(await resolveRunner('web', 'nope')).toBeNull();
    expect((await runnerNames('web')).get('r1')).toBe('box-1');
  });

  it('resolves runners by id or name on later pages and includes them in runner names', async () => {
    (projectFleetRunnersControllerList as jest.Mock)
      .mockResolvedValueOnce(page([box], 1, true))
      .mockResolvedValueOnce(page([{ ...box, id: 'r2', name: 'box-2' }], 2))
      .mockResolvedValueOnce(page([box], 1, true))
      .mockResolvedValueOnce(page([{ ...box, id: 'r2', name: 'box-2' }], 2))
      .mockResolvedValueOnce(page([box], 1, true))
      .mockResolvedValueOnce(page([{ ...box, id: 'r2', name: 'box-2' }], 2));
    expect(await resolveRunner('web', 'box-2')).toEqual({ ...box, id: 'r2', name: 'box-2' });
    expect(await resolveRunner('web', 'r2')).toEqual({ ...box, id: 'r2', name: 'box-2' });
    expect((await runnerNames('web')).get('r2')).toBe('box-2');
  });

  describe('handleFleetError', () => {
    let exit: jest.SpyInstance;
    let err: jest.SpyInstance;
    beforeEach(() => {
      exit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      err = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { exit.mockRestore(); err.mockRestore(); });
    const stderr = () => err.mock.calls.flat().join('\n');

    it.each([
      [{ ret: 40000, message: 'Unauthorized' }, 2],
      [{ ret: 40003, message: 'Forbidden' }, 2],
      [{ ret: -2, message: 'size must not be greater than 100' }, 3],
      [{ ret: 409, message: 'An active job already runs this feature: j1' }, 1],
      [{ ret: 422, message: 'The pinned runner can never run this job: tools' }, 1],
      [new Error('socket hang up'), 1],
    ])('maps %j to exit %i', (body, code) => {
      handleFleetError(body);
      expect(exit).toHaveBeenCalledWith(code);
    });

    it('maps 404 to exit 4 with the not-found message', () => {
      handleFleetError({ ret: 404, message: 'Runner not found' }, { notFoundMessage: 'Runner not found: r9' });
      expect(exit).toHaveBeenCalledWith(4);
      expect(stderr()).toContain('Runner not found: r9');
    });

    it('adds the admin-token hint to a 403 only when asked', () => {
      handleFleetError({ ret: 40003, message: 'Forbidden' }, { adminHint: true });
      expect(stderr()).toContain('global-admin user access token');
      err.mockClear();
      handleFleetError({ ret: 40003, message: 'Forbidden' });
      expect(stderr()).not.toContain('global-admin user access token');
    });

    it('keeps the admin hint inside the structured JSON error', () => {
      setJsonMode(true);
      err.mockClear();
      handleFleetError({ ret: 40003, message: 'Forbidden' }, { adminHint: true });
      const output = stderr();
      expect(JSON.parse(output)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Forbidden', status: 403, hint: 'Requires a global-admin user access token: KODA_API_KEY=<token> koda fleet …' } });
      expect(err).toHaveBeenCalledTimes(1);
    });
  });

  it('printPlacement shows the assigned runner by name, or each misfit', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const job = { id: 'j1', state: 'ASSIGNED' };
    printPlacement({ job, placement: { assigned: true, runnerId: 'r1', misfits: [] } } as never, new Map([['r1', 'box-1']]));
    expect(log.mock.calls.flat().join('\n')).toContain('Assigned to box-1');
    log.mockClear();
    printPlacement(
      { job: { id: 'j2', state: 'QUEUED' }, placement: { assigned: false, runnerId: null, misfits: [{ runnerId: 'r1', name: 'box-1', reason: 'offline' }] } } as never,
      new Map(),
    );
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('Queued: no runner fits now');
    expect(out).toContain('offline');
    log.mockRestore();
  });
});
