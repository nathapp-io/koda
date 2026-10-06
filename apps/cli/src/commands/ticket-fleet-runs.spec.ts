jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  ticketsControllerFindByRef: jest.fn(),
  ticketFleetJobsControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { ticketCommand } from './ticket';
import { ticketFleetJobsControllerList, ticketsControllerFindByRef } from '../generated';
import { resolveContext } from '../config';

const TICKET = { id: 't1', number: 1, ref: 'WEB-1', type: 'TASK', title: 'T', status: 'IN_PROGRESS', createdAt: '', updatedAt: '', links: [] };
const FLEET_JOB = {
  id: 'j1', command: 'RUN', feature: 'f', state: 'ESCALATED', escalationReason: 'review blocked', stateReason: null,
  resultBranch: 'feat/f', resultSha: 'abcdef1234', resultPrUrl: 'https://github.com/acme/app/pull/7',
  costUsd: '0.75', queuedAt: '2026-10-06T00:00:00.000Z', finishedAt: null,
};

describe('koda ticket show: fleet runs (C9 §5)', () => {
  let program: Command;
  let logSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const show = (...a: string[]) =>
    program.commands.find((c) => c.name() === 'ticket')?.commands.find((c) => c.name() === 'show')?.parseAsync(['node', 'test', ...a]);
  const out = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  beforeEach(() => {
    program = new Command();
    ticketCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue({ projectSlug: 'web', apiKey: 'sk-test-key123', apiUrl: 'http://localhost/api' });
    (ticketsControllerFindByRef as jest.Mock).mockResolvedValue({ ret: 0, data: TICKET });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('prints a Fleet runs section', async () => {
    (ticketFleetJobsControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: [FLEET_JOB] });
    await show('WEB-1');
    expect(ticketFleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web', ref: 'WEB-1' } });
    expect(out()).toContain('Fleet runs:');
    expect(out()).toContain('  - RUN f ESCALATED j1 $0.75');
    expect(out()).toContain('    branch feat/f @ abcdef1');
    expect(out()).toContain('    PR https://github.com/acme/app/pull/7');
    expect(out()).toContain('    reason: review blocked');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('adds fleetJobs to --json output', async () => {
    (ticketFleetJobsControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: [FLEET_JOB] });
    await show('--json', 'WEB-1');
    expect(JSON.parse(out()).fleetJobs).toEqual([FLEET_JOB]);
  });

  it('still shows the ticket when the fleet runs lookup fails', async () => {
    (ticketFleetJobsControllerList as jest.Mock).mockRejectedValue(new Error('boom'));
    await show('WEB-1');
    expect(out()).not.toContain('Fleet runs:');
    expect(out()).toContain('Title: T');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
