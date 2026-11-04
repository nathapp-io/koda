jest.mock('chalk', () => ({ cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s }));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));
jest.mock('../generated', () => ({ fleetRulingsControllerList: jest.fn(), fleetRulingsControllerCreate: jest.fn() }));

import { Command } from 'commander';
import { fleetRulingsControllerCreate, fleetRulingsControllerList } from '../generated';
import { resolveContext } from '../config';
import { registerFleetJobRulings } from './fleet-job-rulings';

const ruling = { id: 'rule-1', itemId: 'D-1', disposition: 'confirmed', state: 'skipped', actorType: 'USER', skipReason: 'unknown-item' };
describe('fleet job rulings', () => {
  let program: Command;
  let exit: jest.SpyInstance;
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', ...args]);
  beforeEach(() => {
    program = new Command(); program.exitOverride();
    const fleet = program.command('fleet');
    registerFleetJobRulings(fleet.command('job'));
    (resolveContext as jest.Mock).mockResolvedValue({ apiKey: 'k', apiUrl: 'https://example', projectSlug: 'p' });
    exit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    err = jest.spyOn(console, 'error').mockImplementation(() => {});
    (fleetRulingsControllerList as jest.Mock).mockReset().mockResolvedValue({ ret: 0, data: [ruling] });
    (fleetRulingsControllerCreate as jest.Mock).mockReset().mockResolvedValue({ ret: 0, data: ruling });
  });
  afterEach(() => jest.restoreAllMocks());
  it('lists rulings in a table with the requested fields', async () => {
    await run('fleet', 'job', 'rulings', 'j1');
    const out = log.mock.calls.flat().join(' ');
    for (const value of ['D-1', 'confirmed', 'skipped', 'USER', 'unknown-item', 'Skip reason']) expect(out).toContain(value);
    expect(fleetRulingsControllerList).toHaveBeenCalledWith({ path: { slug: 'p', id: 'j1' } });
  });
  it('outputs the ruling list as JSON', async () => {
    await run('fleet', 'job', 'rulings', 'j1', '--json');
    expect(log.mock.calls.flat().join('')).toContain(JSON.stringify([ruling], null, 2));
  });
  it('creates a ruling and prints its id', async () => {
    await run('fleet', 'job', 'rule', 'j1', 'D-1', 'confirm: test green');
    expect(fleetRulingsControllerCreate).toHaveBeenCalledWith({ path: { slug: 'p', id: 'j1' }, body: { itemId: 'D-1', text: 'confirm: test green' } });
    expect(log.mock.calls.flat().join(' ')).toContain('rule-1');
    expect(exit).toHaveBeenLastCalledWith(0);
  });
  it('exits 3 for empty text without a request', async () => {
    await run('fleet', 'job', 'rule', 'j1', 'D-1', '');
    expect(fleetRulingsControllerCreate).not.toHaveBeenCalled();
    expect(exit).toHaveBeenLastCalledWith(3);
  });
  it('rejects an invalid option before any API call', async () => {
    await expect(run('fleet', 'job', 'rulings', 'j1', '--unknown')).rejects.toMatchObject({ exitCode: 3 });
    expect(fleetRulingsControllerList).not.toHaveBeenCalled();
  });
  it.each([[400, 3], [401, 2], [403, 2], [404, 4], [500, 1]])('maps API status %i to exit %i', async (status, code) => {
    (fleetRulingsControllerCreate as jest.Mock).mockRejectedValue({ statusCode: status, message: 'API message' });
    await run('fleet', 'job', 'rule', 'j1', 'D-1', 'confirm: reason');
    expect(exit).toHaveBeenLastCalledWith(code);
    if (status === 400) expect(err.mock.calls.flat().join(' ')).toContain('API message');
  });
  it('prints approval id and exits 5 for a pending approval', async () => {
    (fleetRulingsControllerCreate as jest.Mock).mockRejectedValue(new (require('../utils/approval-pending').ApprovalPendingError)({ id: 'approval-1', permissionKey: 'fleet.job.rule', requiredMode: 'human', status: 'PENDING', expiresAt: '' }));
    await run('fleet', 'job', 'rule', 'j1', 'D-1', 'confirm: reason');
    expect(err.mock.calls.flat().join(' ')).toContain('approval-1');
    expect(exit).toHaveBeenLastCalledWith(5);
  });
});
