jest.mock('chalk', () => ({ cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s }));
jest.mock('../generated', () => ({
  approvalPoliciesControllerList: jest.fn(), approvalPoliciesControllerKeys: jest.fn(), approvalPoliciesControllerCreate: jest.fn(), approvalPoliciesControllerUpdate: jest.fn(), approvalPoliciesControllerRemove: jest.fn(),
  projectApprovalPoliciesControllerList: jest.fn(), projectApprovalPoliciesControllerKeys: jest.fn(), projectApprovalPoliciesControllerCreate: jest.fn(), projectApprovalPoliciesControllerUpdate: jest.fn(), projectApprovalPoliciesControllerRemove: jest.fn(),
  agentsControllerFindBySlug: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { approvalCommand } from './approval';
import { resolveContext } from '../config';
import { approvalPoliciesControllerCreate, approvalPoliciesControllerList, approvalPoliciesControllerUpdate, approvalPoliciesControllerRemove, projectApprovalPoliciesControllerCreate, projectApprovalPoliciesControllerList, projectApprovalPoliciesControllerRemove, approvalPoliciesControllerKeys, agentsControllerFindBySlug } from '../generated';

const ok = (data: unknown) => ({ ret: 0, data });
describe('approval policy commands', () => {
  let program: Command;
  let log: jest.SpyInstance;
  const run = (...args: string[]) => { program = new Command(); program.exitOverride(); approvalCommand(program); return program.parseAsync(['node', 'koda', 'approval', 'policy', ...args]); };
  beforeEach(() => {
    jest.clearAllMocks(); program = new Command(); program.exitOverride(); approvalCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue({ apiKey: 'key', apiUrl: 'http://localhost' });
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  it('lists global and project policies and formats type subjects', async () => {
    const page = { records: [{ id: 'p1', permissionPattern: 'label.delete', principalType: 'AGENT', roleId: null, principalId: null, mode: 'human', projectId: null, timeoutSec: null }], hasNext: false };
    (approvalPoliciesControllerList as jest.Mock).mockResolvedValue(ok(page));
    (projectApprovalPoliciesControllerList as jest.Mock).mockResolvedValue(ok(page));
    await run('list'); await run('list', '--project', 'web');
    expect(approvalPoliciesControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20 } });
    expect(projectApprovalPoliciesControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { current: 1, size: 20 } });
    expect(log.mock.calls.flat().join('\n')).toContain('type:AGENT');
  });
  it('lists keys', async () => { (approvalPoliciesControllerKeys as jest.Mock).mockResolvedValue(ok({ keys: [] })); await run('keys'); expect(approvalPoliciesControllerKeys).toHaveBeenCalled(); });
  it('sets policy and handles subjects/options on global and project routes', async () => {
    (approvalPoliciesControllerCreate as jest.Mock).mockResolvedValue(ok({ id: 'p1' }));
    (projectApprovalPoliciesControllerCreate as jest.Mock).mockResolvedValue(ok({ id: 'p2' }));
    (agentsControllerFindBySlug as jest.Mock).mockResolvedValue(ok({ id: 'a1' }));
    await run('set', '--pattern', 'label.delete', '--mode', 'human', '--type', 'AGENT');
    expect(approvalPoliciesControllerCreate).toHaveBeenCalledWith({ body: { permissionPattern: 'label.delete', mode: 'human', appliesTo: { kind: 'type', principalType: 'AGENT' } } });
    await run('set', '--pattern', 'label.delete', '--mode', 'agent');
    expect(approvalPoliciesControllerCreate).toHaveBeenLastCalledWith({ body: { permissionPattern: 'label.delete', mode: 'agent', appliesTo: { kind: 'all' } } });
    await run('set', '--pattern', 'label.delete', '--mode', 'human', '--agent', 'reviewer-bot');
    expect(approvalPoliciesControllerCreate).toHaveBeenLastCalledWith({ body: { permissionPattern: 'label.delete', mode: 'human', appliesTo: { kind: 'principal', principalType: 'AGENT', principalId: 'a1' } } });
    await run('set', '--pattern', 'label.delete', '--mode', 'human', '--project', 'web');
    expect(projectApprovalPoliciesControllerCreate).toHaveBeenCalledWith({ path: { slug: 'web' }, body: { permissionPattern: 'label.delete', mode: 'human', appliesTo: { kind: 'all' } } });
    await run('set', '--pattern', 'label.delete', '--mode', 'human', '--approver-need-not-hold', '--distinct-approver', '--timeout', '600', '--on-timeout', 'reject');
    expect(approvalPoliciesControllerCreate).toHaveBeenLastCalledWith({ body: { permissionPattern: 'label.delete', mode: 'human', appliesTo: { kind: 'all' }, approverMustHoldAction: false, requireDistinctApprover: true, timeoutSec: 600, onTimeout: 'reject' } });
  });
  it('rejects conflicting selectors with exit 3 and no calls', async () => {
    await run('set', '--pattern', 'label.delete', '--mode', 'human', '--type', 'AGENT', '--role', 'r1');
    expect(process.exit).toHaveBeenCalledWith(3);
    expect(approvalPoliciesControllerCreate).not.toHaveBeenCalled();
  });
  it('updates and refuses empty update', async () => {
    (approvalPoliciesControllerUpdate as jest.Mock).mockResolvedValue(ok({ id: 'p1' }));
    await run('update', 'p1', '--no-timeout');
    expect(approvalPoliciesControllerUpdate).toHaveBeenCalledWith({ path: { id: 'p1' }, body: { timeoutSec: null } });
    await run('update', 'p1');
    expect(process.exit).toHaveBeenCalledWith(3);
    expect(approvalPoliciesControllerUpdate).toHaveBeenCalledTimes(1);
  });
  it('deletes through project route', async () => {
    (projectApprovalPoliciesControllerRemove as jest.Mock).mockResolvedValue(ok(undefined));
    await run('delete', 'p1', '--project', 'web');
    expect(projectApprovalPoliciesControllerRemove).toHaveBeenCalledWith({ path: { slug: 'web', id: 'p1' } });
  });
});
