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
import { InvalidArgumentError } from 'commander';
import { fleetCommand } from './fleet';
import { parseRequeue, parseStatus, parseType } from './fleet-approval';
import {
  fleetApprovalsControllerDecide, fleetApprovalsControllerGet, fleetApprovalsControllerList, projectFleetApprovalsControllerDecide,
  projectFleetApprovalsControllerGet, projectFleetApprovalsControllerList,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol',
  payload: { spentUsd: '10', amountUsd: '10', scopeType: 'project' }, outcome: null, requestedAt: '2026-10-02T10:00:00.000Z',
  expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });
const page = (records: unknown[], over: Record<string, unknown> = {}) =>
  ({ total: records.length, current: 1, size: 20, hasNext: false, records, ...over });

describe('koda fleet approval', () => {
  let program: Command;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'approval', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  const logged = () => logSpy.mock.calls.flat().join('\n');
  const errored = () => errSpy.mock.calls.flat().join('\n');

  it('parses --requeue', () => {
    expect(parseRequeue('all')).toBe('all');
    expect(parseRequeue('j1,j2')).toEqual(['j1', 'j2']);
    expect(() => parseRequeue(',')).toThrow();
  });

  it('list uses the admin route without --project and passes filters', async () => {
    (fleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok(page([row()])));
    await run('list', '--status', 'pending');
    expect(fleetApprovalsControllerList).toHaveBeenCalledWith({ query: { current: 1, size: 20, status: 'pending' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('a1');
  });

  it('list sends --page/--size and prints the next-page hint', async () => {
    // Without this a >20 approval history looked complete: the API default size is 20 and the CLI printed
    // `page.records` and stopped.
    (projectFleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok(page([row()], { current: 2, size: 5, hasNext: true })));
    await run('list', '--project', 'web', '--page', '2', '--size', '5');
    expect(projectFleetApprovalsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { current: 2, size: 5 } });
    expect(logged()).toContain('Next: --page 3');
  });

  it('list prints no hint on the last page', async () => {
    (projectFleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok(page([row()])));
    await run('list', '--project', 'web');
    expect(logged()).not.toContain('Next: --page');
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
    // One `get`, not two: an extra round-trip on this path would pass silently without this.
    expect(projectFleetApprovalsControllerGet).toHaveBeenCalledTimes(1);
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

  it('parses the list filters and refuses anything else', () => {
    expect(parseStatus('pending')).toBe('pending');
    expect(parseStatus('cancelled')).toBe('cancelled');
    expect(() => parseStatus('bogus')).toThrow(InvalidArgumentError);
    expect(() => parseStatus('bogus')).toThrow(/expected pending, approved, rejected, expired, cancelled/);
    expect(parseType('budget_override_required')).toBe('budget_override_required');
    expect(() => parseType('bogus')).toThrow(InvalidArgumentError);
    expect(() => parseType('bogus')).toThrow(/expected budget_override_required, nax_bash_escalate/);
  });

  it('refuses an undecidable --decision before any request', async () => {
    // Commander rewraps a parser error as CommanderError, so the parser's own message is the assertion.
    await expect(run('decide', 'a1', '--decision', 'allow')).rejects.toThrow(/expected keep_paused or raise_budget_and_resume/);
    expect(fleetApprovalsControllerDecide).not.toHaveBeenCalled();
    expect(projectFleetApprovalsControllerDecide).not.toHaveBeenCalled();
  });

  it('list uses the project route with --project and rejects a bad filter before any request', async () => {
    (projectFleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok(page([row()])));
    await run('list', '--project', 'web');
    expect(projectFleetApprovalsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' }, query: { current: 1, size: 20 } });
    expect(fleetApprovalsControllerList).not.toHaveBeenCalled();
    await expect(run('list', '--status', 'bogus')).rejects.toThrow(/expected pending, approved, rejected, expired, cancelled/);
    expect(projectFleetApprovalsControllerList).toHaveBeenCalledTimes(1);
  });

  it('list --json emits the whole page, so a script can tell 20-of-20 from 20-of-500', async () => {
    (projectFleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok(page([row()], { total: 500, hasNext: true })));
    await run('list', '--project', 'web', '--json');
    const printed = JSON.parse(logged());
    expect(printed).toMatchObject({ total: 500, current: 1, size: 20, hasNext: true });
    expect(printed.records).toHaveLength(1);
    expect(printed.records[0]).toMatchObject({ id: 'a1' });
  });

  it('show uses the project route and lists re-queue candidates with the truncation notice', async () => {
    (projectFleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({
      requeueCandidates: [{ jobId: 'j1', projectId: 'p1', feature: 'login-fix', queuedAt: '2026-10-02T09:00:00.000Z' }],
      requeueCandidatesTruncated: true,
    })));
    await run('show', 'a1', '--project', 'web');
    expect(projectFleetApprovalsControllerGet).toHaveBeenCalledWith({ path: { slug: 'web', id: 'a1' } });
    expect(fleetApprovalsControllerGet).not.toHaveBeenCalled();
    expect(logged()).toContain('Showing approval a1: budget_override_required pending');
    expect(logged()).toContain('candidate j1 login-fix');
    expect(logged()).toContain('(more candidates exist)');
  });

  it('show --json emits the whole approval, candidates included', async () => {
    (fleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({
      requeueCandidates: [{ jobId: 'j1', projectId: 'p1', feature: 'login-fix', queuedAt: '2026-10-02T09:00:00.000Z' }],
    })));
    await run('show', 'a1', '--json');
    expect(fleetApprovalsControllerGet).toHaveBeenCalledWith({ path: { id: 'a1' } });
    const printed = JSON.parse(logged());
    expect(printed).toMatchObject({ id: 'a1', status: 'pending' });
    expect(printed.requeueCandidates).toEqual([expect.objectContaining({ jobId: 'j1', feature: 'login-fix' })]);
  });

  it('decide --requeue all refuses when the candidate list was capped, naming the ids to pass instead', async () => {
    // A capped list means the page the CLI can see is the oldest slice, which the decide's
    // `finishedAt >= requestedAt` window filters out — so `all` would silently re-queue nothing.
    (projectFleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({
      requeueCandidates: [{ jobId: 'j1' }, { jobId: 'j2' }], requeueCandidatesTruncated: true,
    })));
    await run('decide', 'a1', '--project', 'web', '--decision', 'raise_budget_and_resume', '--requeue', 'all');
    // The count is interpolated, so it cannot drift from MAX_REQUEUE_CANDIDATES.
    expect(errored()).toContain('More candidates exist; only the first 2 are re-queued.');
    expect(errored()).toContain('koda fleet approval show');
    expect(projectFleetApprovalsControllerDecide).not.toHaveBeenCalled();
  });

  it('decide --requeue all says nothing when the candidate list was not capped', async () => {
    (projectFleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({ requeueCandidates: [{ jobId: 'j1' }] })));
    (projectFleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'approved' })));
    await run('decide', 'a1', '--project', 'web', '--decision', 'raise_budget_and_resume', '--requeue', 'all');
    expect(errored()).not.toContain('More candidates exist');
  });
});
