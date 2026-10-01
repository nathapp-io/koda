jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
jest.mock('../generated', () => ({
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));

import { projectFleetReposControllerList, projectFleetRunnersControllerList } from '../generated';
import { ago, pageHint, printPlacement, resolveRepo, resolveRunner, runnerNames, splitRepoPath } from './fleet-shared';

const ok = <T>(data: T) => ({ ret: 0, data });
const page = <T>(records: T[], current = 1, hasNext = false) => ok({ total: records.length, current, size: 100, hasNext, hasPrev: current > 1, records });
const repoA = { id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdAt: '' };
const repoB = { id: 'fr2', projectId: 'p', provider: 'gitlab', owner: 'group/sub', name: 'svc', defaultBranch: 'main', createdAt: '' };
const box = { id: 'r1', name: 'box-1', os: 'linux', arch: 'x64', labels: [], enabled: true, online: true, profiles: [] };

describe('fleet-shared', () => {
  afterEach(() => {
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
