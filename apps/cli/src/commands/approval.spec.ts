jest.mock('chalk', () => ({ cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s }));
jest.mock('../generated', () => ({
  approvalRequestsControllerList: jest.fn(), approvalRequestsControllerGet: jest.fn(),
  approvalRequestsControllerDecide: jest.fn(), approvalRequestsControllerCancel: jest.fn(),
  projectsControllerFindBySlug: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { approvalCommand } from './approval';
import { approvalRequestsControllerList, approvalRequestsControllerGet, approvalRequestsControllerDecide,
  approvalRequestsControllerCancel, projectsControllerFindBySlug } from '../generated';
import { resolveContext } from '../config';
import { setJsonMode } from '../utils/json-mode';

const ok = (data: unknown) => ({ ret: 0, data });
const req = (over: Record<string, unknown> = {}) => ({
  id: 'r1', permissionKey: 'label.delete', projectId: null, actorType: 'AGENT', actorId: 'a1',
  onBehalfOfType: null, onBehalfOfId: null, origin: 'api', requiredMode: 'human', status: 'pending',
  satisfiedBy: null, approverType: null, approverId: null, expiresAt: '2026-01-01', decidedAt: null,
  settledAt: null, createdAt: '2025-01-01', input: { labelId: 'l1' }, result: null, decisions: [], ...over,
});

describe('koda approval request commands', () => {
  let program: Command;
  let log: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'approval', ...args]);
  const printed = () => log.mock.calls.flat().join('\n');
  beforeEach(() => {
    program = new Command(); program.exitOverride(); approvalCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue({ apiKey: 'k', apiUrl: 'https://example.test' });
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { setJsonMode(false); jest.clearAllMocks(); jest.restoreAllMocks(); });

  it('AC-1: default list query', async () => {
    (approvalRequestsControllerList as jest.Mock).mockResolvedValue(ok({ current: 1, size: 20, hasNext: false, records: [] }));
    await run('list');
    expect(approvalRequestsControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20 } });
    expect(resolveContext).toHaveBeenCalledWith({});
  });
  it('AC-2: explicit filters and mine true', async () => {
    (approvalRequestsControllerList as jest.Mock).mockResolvedValue(ok({ hasNext: false, records: [] }));
    await run('list', '--status', 'pending', '--key', 'label.delete', '--mine');
    expect(approvalRequestsControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20, status: 'pending', permissionKey: 'label.delete', mine: true } });
  });
  it('AC-3: project slug is resolved before list', async () => {
    (projectsControllerFindBySlug as jest.Mock).mockResolvedValue(ok({ id: 'p1' }));
    (approvalRequestsControllerList as jest.Mock).mockResolvedValue(ok({ records: [], hasNext: false }));
    await run('list', '--project', 'web');
    expect(projectsControllerFindBySlug).toHaveBeenCalledWith(expect.objectContaining({ path: { slug: 'web' } }));
    expect(approvalRequestsControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20, projectId: 'p1' } });
  });
  it('AC-4/5: table headers and global project label', async () => {
    (approvalRequestsControllerList as jest.Mock).mockResolvedValue(ok({ records: [req()], hasNext: false }));
    await run('list');
    for (const header of ['ID', 'Status', 'Key', 'Project', 'Actor', 'Requires', 'Expires']) expect(printed().split('\n')[0]).toContain(header);
    expect(printed()).toContain('global');
  });
  it('AC-6: JSON emits unwrapped page', async () => {
    const page = { records: [req()], hasNext: false };
    (approvalRequestsControllerList as jest.Mock).mockResolvedValue(ok(page));
    await run('list', '--json'); expect(JSON.parse(printed())).toEqual(page);
  });
  it('AC-7/8: show request fields then input and decision line', async () => {
    (approvalRequestsControllerGet as jest.Mock).mockResolvedValue(ok(req({ decisions: [{ decidedAt: 'now', decision: 'reject', deciderType: 'USER', deciderId: 'u1', comment: 'no' }] })));
    await run('show', 'r1');
    expect(approvalRequestsControllerGet).toHaveBeenCalledWith({ path: { id: 'r1' } });
    expect(printed().split('\n').slice(-5)).toEqual(['input:', '  {', '    "labelId": "l1"', '  }', 'now reject by USER/u1: no']);
  });
  it('AC-9/10: approve includes comment and prints status', async () => {
    (approvalRequestsControllerDecide as jest.Mock).mockResolvedValue(ok({ ...req(), status: 'executed' }));
    await run('approve', 'r1', '--comment', 'ok');
    expect(approvalRequestsControllerDecide).toHaveBeenCalledWith({ path: { id: 'r1' }, body: { decision: 'approve', comment: 'ok' } });
    expect(printed()).toContain('r1 executed');
  });
  it('AC-11: reject omits absent comment', async () => {
    (approvalRequestsControllerDecide as jest.Mock).mockResolvedValue(ok(req()));
    await run('reject', 'r1');
    expect(approvalRequestsControllerDecide).toHaveBeenCalledWith({ path: { id: 'r1' }, body: { decision: 'reject' } });
  });
  it('AC-12/13: cancel request and print status', async () => {
    (approvalRequestsControllerCancel as jest.Mock).mockResolvedValue(ok({ ...req(), status: 'cancelled' }));
    await run('cancel', 'r1');
    expect(approvalRequestsControllerCancel).toHaveBeenCalledWith({ path: { id: 'r1' } });
    expect(printed()).toContain('r1 cancelled');
  });
  it('AC-14: 403 decide error exits with auth code 2', async () => {
    (approvalRequestsControllerDecide as jest.Mock).mockRejectedValue({ status: 403, message: 'forbidden' });
    await run('approve', 'r1');
    expect(process.exit).toHaveBeenCalledWith(2);
  });
  it('AC-15: registered on a program', () => {
    expect(program.commands.some((command) => command.name() === 'approval')).toBe(true);
  });
});
