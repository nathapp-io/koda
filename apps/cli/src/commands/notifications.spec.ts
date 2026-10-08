jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  meNotificationsControllerList: jest.fn(),
  meNotificationsControllerMarkRead: jest.fn(),
  meNotificationsControllerMarkAllRead: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { notificationsCommand } from './notifications';
import { meNotificationsControllerList, meNotificationsControllerMarkAllRead, meNotificationsControllerMarkRead } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };
const PAGE = {
  ret: 0,
  data: {
    total: 1, current: 1, size: 20, hasNext: false, hasPrev: false,
    records: [{ id: 'n1', kind: 'ticket_assigned', title: 'Root assigned you KODA-1: Fix', link: '/koda/tickets/KODA-1', readAt: null, createdAt: '2026-10-09T00:00:00.000Z' }],
  },
};

describe('notificationsCommand (S4a §3)', () => {
  let program: Command;
  let log: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    notificationsCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('lists by default, newest first, with the unread filter and paging', async () => {
    (meNotificationsControllerList as jest.Mock).mockResolvedValue(PAGE);
    await program.parseAsync(['node', 'koda', 'notifications', '--unread', '--page', '2']);
    expect(meNotificationsControllerList).toHaveBeenCalledWith({ query: { current: 2, size: 20, unread: 'true' } });
    expect(log.mock.calls.flat().join('\n')).toContain('Root assigned you KODA-1: Fix');
  });

  it('prints JSON with --json', async () => {
    (meNotificationsControllerList as jest.Mock).mockResolvedValue(PAGE);
    await program.parseAsync(['node', 'koda', 'notifications', 'list', '--json']);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(PAGE.data);
  });

  it('marks one read', async () => {
    (meNotificationsControllerMarkRead as jest.Mock).mockResolvedValue({});
    await program.parseAsync(['node', 'koda', 'notifications', 'read', 'n1']);
    expect(meNotificationsControllerMarkRead).toHaveBeenCalledWith({ path: { id: 'n1' } });
  });

  it('marks all read', async () => {
    (meNotificationsControllerMarkAllRead as jest.Mock).mockResolvedValue({});
    await program.parseAsync(['node', 'koda', 'notifications', 'read', '--all']);
    expect(meNotificationsControllerMarkAllRead).toHaveBeenCalledWith({});
  });

  it('refuses read without an id or --all', async () => {
    await program.parseAsync(['node', 'koda', 'notifications', 'read']);
    expect(meNotificationsControllerMarkRead).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
