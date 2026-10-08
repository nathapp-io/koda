jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  ticketWatchControllerWatch: jest.fn(),
  ticketWatchControllerUnwatch: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { registerTicketWatch } from './ticket-watch';
import { ticketWatchControllerUnwatch, ticketWatchControllerWatch } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('koda ticket watch|unwatch (S4a §3)', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerTicketWatch(program.command('ticket'));
    (resolveContext as jest.Mock).mockImplementation(async (flags: { projectSlug?: string }) => ({ ...CTX, projectSlug: flags.projectSlug ?? CTX.projectSlug }));
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('watch targets the context project', async () => {
    (ticketWatchControllerWatch as jest.Mock).mockResolvedValue({ ret: 0, data: { watching: true, count: 2 } });
    await program.parseAsync(['node', 'koda', 'ticket', 'watch', 'KODA-1']);
    expect(ticketWatchControllerWatch).toHaveBeenCalledWith({ path: { slug: 'my-proj', ref: 'KODA-1' } });
  });

  it('unwatch honours --project', async () => {
    (ticketWatchControllerUnwatch as jest.Mock).mockResolvedValue({ ret: 0, data: { watching: false, count: 1 } });
    await program.parseAsync(['node', 'koda', 'ticket', 'unwatch', 'KODA-1', '--project', 'other']);
    expect(ticketWatchControllerUnwatch).toHaveBeenCalledWith({ path: { slug: 'other', ref: 'KODA-1' } });
  });
});
