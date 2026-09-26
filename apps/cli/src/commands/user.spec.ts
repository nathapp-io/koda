jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  adminUsersControllerList: jest.fn(),
  adminUsersControllerCreate: jest.fn(),
  adminUsersControllerUpdate: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { userCommand } from './user';
import { adminUsersControllerCreate, adminUsersControllerList, adminUsersControllerUpdate } from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'http://localhost:3100/api', projectSlug: 'p' };
const page = { total: 1, current: 1, size: 20, hasNext: false, hasPrev: false, records: [{ id: 'u1', email: 'a@k.t', name: 'A', role: 'MEMBER', disabled: false }] };

describe('userCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    userCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('list sends paging and the email filter', async () => {
    (adminUsersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await program.parseAsync(['node', 'koda', 'user', 'list', '--email', 'a@', '--page', '2', '--size', '5']);
    expect(adminUsersControllerList).toHaveBeenCalledWith({ query: { email: 'a@', current: 2, size: 5 } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('list --json prints the page', async () => {
    (adminUsersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: page });
    await program.parseAsync(['node', 'koda', 'user', 'list', '--json']);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
  });

  it('create sends the body with role MEMBER by default', async () => {
    (adminUsersControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: { id: 'u2', email: 'b@k.t' } });
    await program.parseAsync(['node', 'koda', 'user', 'create', '--email', 'b@k.t', '--name', 'B', '--password', 'Admin1234!Aa']);
    expect(adminUsersControllerCreate).toHaveBeenCalledWith({ body: { email: 'b@k.t', name: 'B', password: 'Admin1234!Aa', role: 'MEMBER' } });
  });

  it('disable patches disabled=true', async () => {
    (adminUsersControllerUpdate as jest.Mock).mockResolvedValue({ ret: 0, data: { id: 'u2', disabled: true } });
    await program.parseAsync(['node', 'koda', 'user', 'disable', 'u2']);
    expect(adminUsersControllerUpdate).toHaveBeenCalledWith({ path: { id: 'u2' }, body: { disabled: true } });
  });
});
