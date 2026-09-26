jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  projectMembersControllerList: jest.fn(),
  projectMembersControllerAdd: jest.fn(),
  projectMembersControllerUpdateRole: jest.fn(),
  projectMembersControllerRemove: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { memberCommand } from './member';
import {
  projectMembersControllerAdd,
  projectMembersControllerList,
  projectMembersControllerRemove,
  projectMembersControllerUpdateRole,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'k', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('memberCommand', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    memberCommand(program);
    // withContext passes the flags straight to resolveContext; honor --project.
    (resolveContext as jest.Mock).mockImplementation(async (flags: { projectSlug?: string }) => ({
      ...CTX,
      projectSlug: flags.projectSlug ?? CTX.projectSlug,
    }));
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  it('list pages members of the context project', async () => {
    (projectMembersControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: { total: 0, current: 1, size: 20, hasNext: false, hasPrev: false, records: [] } });
    await program.parseAsync(['node', 'koda', 'member', 'list', '--page', '2']);
    expect(projectMembersControllerList).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, query: { current: 2, size: 20 } });
  });

  it('add sends email and role', async () => {
    (projectMembersControllerAdd as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'a@k.t', role: 'DEVELOPER' } });
    await program.parseAsync(['node', 'koda', 'member', 'add', '--email', 'a@k.t', '--role', 'DEVELOPER']);
    expect(projectMembersControllerAdd).toHaveBeenCalledWith({ path: { slug: 'my-proj' }, body: { email: 'a@k.t', role: 'DEVELOPER' } });
  });

  it('role changes a member role', async () => {
    (projectMembersControllerUpdateRole as jest.Mock).mockResolvedValue({ ret: 0, data: { userId: 'u1', email: 'a@k.t', role: 'VIEWER' } });
    await program.parseAsync(['node', 'koda', 'member', 'role', 'u1', '--role', 'VIEWER']);
    expect(projectMembersControllerUpdateRole).toHaveBeenCalledWith({ path: { slug: 'my-proj', userId: 'u1' }, body: { role: 'VIEWER' } });
  });

  it('remove targets the --project override', async () => {
    (projectMembersControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: {} });
    await program.parseAsync(['node', 'koda', 'member', 'remove', 'u1', '--project', 'other']);
    expect(projectMembersControllerRemove).toHaveBeenCalledWith({ path: { slug: 'other', userId: 'u1' } });
  });
});
