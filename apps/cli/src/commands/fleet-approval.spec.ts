jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetApprovalsControllerList: jest.fn(),
  fleetApprovalsControllerGet: jest.fn(),
  fleetApprovalsControllerDecide: jest.fn(),
  projectFleetApprovalsControllerList: jest.fn(),
  projectFleetApprovalsControllerGet: jest.fn(),
  projectFleetApprovalsControllerDecide: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { parseRequeue } from './fleet-approval';
import {
  fleetApprovalsControllerDecide, fleetApprovalsControllerList, projectFleetApprovalsControllerDecide, projectFleetApprovalsControllerGet,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol',
  payload: { spentUsd: '10', amountUsd: '10', scopeType: 'project' }, outcome: null, requestedAt: '2026-10-02T10:00:00.000Z',
  expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });

describe('koda fleet approval', () => {
  let program: Command;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'approval', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses --requeue', () => {
    expect(parseRequeue('all')).toBe('all');
    expect(parseRequeue('j1,j2')).toEqual(['j1', 'j2']);
    expect(() => parseRequeue(',')).toThrow();
  });

  it('list uses the admin route without --project and passes filters', async () => {
    (fleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok({ total: 1, current: 1, size: 20, records: [row()] }));
    await run('list', '--status', 'pending');
    expect(fleetApprovalsControllerList).toHaveBeenCalledWith({ query: { status: 'pending' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('a1');
  });

  it('decide keep_paused on the project route', async () => {
    (projectFleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'rejected', decision: 'keep_paused' })));
    await run('decide', 'a1', '--project', 'web', '--decision', 'keep_paused', '--comment', 'later');
    expect(projectFleetApprovalsControllerDecide).toHaveBeenCalledWith({ path: { slug: 'web', id: 'a1' }, body: { decision: 'keep_paused', comment: 'later' } });
  });

  it('decide raise with --requeue all sends every candidate from a fresh show', async () => {
    (projectFleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({ requeueCandidates: [{ jobId: 'j1' }, { jobId: 'j2' }] })));
    (projectFleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'approved', outcome: { requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: 'x' }] } })));
    await run('decide', 'a1', '--project', 'web', '--decision', 'raise_budget_and_resume', '--amount', '25', '--requeue', 'all');
    expect(projectFleetApprovalsControllerDecide).toHaveBeenCalledWith({
      path: { slug: 'web', id: 'a1' }, body: { decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: ['j1', 'j2'] },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('1 of 2 re-queued');
  });

  it('decide on the admin route without --project', async () => {
    (fleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'rejected' })));
    await run('decide', 'a1', '--decision', 'keep_paused');
    expect(fleetApprovalsControllerDecide).toHaveBeenCalledWith({ path: { id: 'a1' }, body: { decision: 'keep_paused' } });
  });
});
