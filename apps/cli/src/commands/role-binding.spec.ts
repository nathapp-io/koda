jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  agentsControllerFindBySlug: jest.fn(),
  projectsControllerFindBySlug: jest.fn(),
  roleBindingsControllerCreate: jest.fn(),
  roleBindingsControllerList: jest.fn(),
  roleBindingsControllerRemove: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { roleBindingCommand } from './role-binding';
import {
  agentsControllerFindBySlug,
  projectsControllerFindBySlug,
  roleBindingsControllerCreate,
  roleBindingsControllerList,
  roleBindingsControllerRemove,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'http://localhost:3100', projectSlug: 'koda' };

const BINDING = {
  id: 'b1',
  principalType: 'USER',
  principalId: 'u1',
  roleId: 'r1',
  roleKey: 'admin',
  projectId: 'p1',
  grantedByType: 'USER',
  grantedById: 'u9',
  createdAt: '2026-01-02T03:04:05.000Z',
};

const GLOBAL_BINDING = { ...BINDING, id: 'b2', projectId: null };

function pageWith(records: unknown[]) {
  return { total: records.length, current: 1, size: 20, hasNext: false, hasPrev: false, records };
}

const logLines = (logSpy: jest.SpyInstance): string[] =>
  logSpy.mock.calls.map((call) => String(call[0]));

function noApiCall(): void {
  expect(agentsControllerFindBySlug).not.toHaveBeenCalled();
  expect(projectsControllerFindBySlug).not.toHaveBeenCalled();
  expect(roleBindingsControllerCreate).not.toHaveBeenCalled();
  expect(roleBindingsControllerList).not.toHaveBeenCalled();
  expect(roleBindingsControllerRemove).not.toHaveBeenCalled();
}

describe('roleBindingCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    roleBindingCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    (projectsControllerFindBySlug as jest.Mock).mockResolvedValue({ ret: 0, data: { id: 'p1', slug: 'koda' } });
    (agentsControllerFindBySlug as jest.Mock).mockResolvedValue({ ret: 0, data: { id: 'a1', slug: 'bot-1' } });
    (roleBindingsControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: pageWith([BINDING]) });
    (roleBindingsControllerCreate as jest.Mock).mockResolvedValue({ ret: 0, data: BINDING });
    (roleBindingsControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: undefined });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('list', () => {
    it("AC-1: sends query.projectId resolved from --project", async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'list', '--project', 'koda']);
      expect(projectsControllerFindBySlug).toHaveBeenCalledWith({ path: { slug: 'koda' } });
      const [call] = (roleBindingsControllerList as jest.Mock).mock.calls;
      expect(call[0].query.projectId).toBe('p1');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("AC-2: sends query.scope 'global' for --global", async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'list', '--global']);
      const [call] = (roleBindingsControllerList as jest.Mock).mock.calls;
      expect(call[0].query.scope).toBe('global');
    });

    it('AC-3: sends exactly the principal filter and the page', async () => {
      await program.parseAsync([
        'node', 'koda', 'role-binding', 'list', '--type', 'AGENT', '--principal', 'a1', '--page', '2', '--size', '50',
      ]);
      expect(roleBindingsControllerList).toHaveBeenCalledWith({
        query: { current: 2, size: 50, principalType: 'AGENT', principalId: 'a1' },
      });
    });

    it('AC-4: prints the binding table header', async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'list']);
      expect(logLines(logSpy).some((line) => /^ID\s+Type\s+Principal\s+Role\s+Project\s+Granted\s*$/.test(line))).toBe(true);
    });

    it("AC-5: prints 'global' in the Project cell of a binding with no project", async () => {
      (roleBindingsControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: pageWith([GLOBAL_BINDING]) });
      await program.parseAsync(['node', 'koda', 'role-binding', 'list']);
      const row = logLines(logSpy).find((line) => line.includes('b2'));
      expect(row).toBeDefined();
      expect(row).toContain('global');
      expect(row).not.toContain('null');
    });
  });

  describe('grant', () => {
    it('AC-6: grants a role to a user in a project', async () => {
      await program.parseAsync([
        'node', 'koda', 'role-binding', 'grant', '--role', 'developer', '--user', 'u1', '--project', 'koda',
      ]);
      expect(roleBindingsControllerCreate).toHaveBeenCalledWith({
        body: { principalType: 'USER', principalId: 'u1', roleKey: 'developer', projectId: 'p1' },
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('AC-7: grants a role to an agent in a project, resolving the agent id', async () => {
      await program.parseAsync([
        'node', 'koda', 'role-binding', 'grant', '--role', 'reviewer', '--agent', 'bot-1', '--project', 'koda',
      ]);
      expect(agentsControllerFindBySlug).toHaveBeenCalledWith({ path: { slug: 'bot-1' } });
      expect(roleBindingsControllerCreate).toHaveBeenCalledWith({
        body: { principalType: 'AGENT', principalId: 'a1', roleKey: 'reviewer', projectId: 'p1' },
      });
    });

    it('AC-8: sends projectId null without --project, even from a local project config', async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'grant', '--role', 'admin', '--user', 'u1']);
      expect(CTX.projectSlug).toBe('koda');
      expect(roleBindingsControllerCreate).toHaveBeenCalledWith({
        body: { principalType: 'USER', principalId: 'u1', roleKey: 'admin', projectId: null },
      });
      expect(projectsControllerFindBySlug).not.toHaveBeenCalled();
    });

    it('AC-9: prints the grant with the binding id from the API', async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'grant', '--role', 'admin', '--user', 'u1']);
      expect(logLines(logSpy)).toContain('Granted admin to u1 (binding b1)');
    });

    it('AC-10: refuses both --user and --agent with exit 3 and no API call', async () => {
      await program.parseAsync([
        'node', 'koda', 'role-binding', 'grant', '--role', 'developer', '--user', 'u1', '--agent', 'bot-1',
      ]);
      expect(exitSpy).toHaveBeenCalledWith(3);
      noApiCall();
    });

    it('AC-11: refuses neither principal with exit 3 and no API call', async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'grant', '--role', 'developer']);
      expect(exitSpy).toHaveBeenCalledWith(3);
      noApiCall();
    });

    it('AC-12: an unknown agent slug stops before the create', async () => {
      const notFound = Object.assign(new Error('Agent not found'), { statusCode: 404 });
      (agentsControllerFindBySlug as jest.Mock).mockRejectedValue(notFound);
      await program.parseAsync([
        'node', 'koda', 'role-binding', 'grant', '--role', 'developer', '--agent', 'nope',
      ]);
      expect(roleBindingsControllerCreate).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalledWith(0);
    });

    it('AC-14: --json prints the answered binding', async () => {
      await program.parseAsync([
        'node', 'koda', 'role-binding', 'grant', '--role', 'admin', '--user', 'u1', '--json',
      ]);
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(BINDING, null, 2));
    });
  });

  describe('revoke', () => {
    it('AC-13: revokes the binding by id', async () => {
      await program.parseAsync(['node', 'koda', 'role-binding', 'revoke', 'b1']);
      expect(roleBindingsControllerRemove).toHaveBeenCalledWith({ path: { id: 'b1' } });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('registration', () => {
    it('AC-15: registers the role-binding group with list, grant and revoke', () => {
      const fresh = new Command();
      roleBindingCommand(fresh);
      const group = fresh.commands.find((command) => command.name() === 'role-binding');
      expect(group).toBeDefined();
      expect(group?.commands.map((command) => command.name())).toEqual(['list', 'grant', 'revoke']);
    });
  });
});
