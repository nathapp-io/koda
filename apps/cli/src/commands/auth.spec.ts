jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s },
  gray: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
}));

const mockData: Record<string, string> = {};
const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => { mockData[key] = value; }),
};
jest.mock('conf', () => jest.fn(() => mockStore));

jest.mock('../generated', () => ({
  authControllerMe: jest.fn(),
  authControllerRegister: jest.fn(),
  authControllerLogout: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
  clearUsedCredential: jest.fn(() => 'none'),
}));

jest.mock('../utils/output', () => ({
  table: jest.fn(),
  error: jest.fn(),
}));

import { Command } from 'commander';
import { authCommand } from './auth';
import { authControllerMe, authControllerRegister, authControllerLogout } from '../generated';
import { resolveContext, clearUsedCredential } from '../config';
import { table } from '../utils/output';

const mockResolveContext = resolveContext as jest.Mock;
const mockMe = authControllerMe as jest.Mock;
const mockRegister = authControllerRegister as jest.Mock;
const mockLogout = authControllerLogout as jest.Mock;
const mockClearUsedCredential = clearUsedCredential as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj', credential: { source: 'environment', key: 'sk-test' } };

describe('authCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    authCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('me', () => {
    it('fetches and prints current user as a table', async () => {
      const user = { id: 'u-1', email: 'user@example.com', name: 'Alice', role: 'admin' };
      mockMe.mockResolvedValue({ ret: 0, data: user });

      await program.parseAsync(['node', 'koda', 'auth', 'me']);

      expect(mockMe).toHaveBeenCalled();
      expect(table).toHaveBeenCalledWith(['Field', 'Value'], [
        ['ID', 'u-1'],
        ['Email', 'user@example.com'],
        ['Name', 'Alice'],
      ]);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const user = { id: 'u-1', email: 'user@example.com', name: 'Alice', role: 'admin' };
      mockMe.mockResolvedValue({ ret: 0, data: user });

      await program.parseAsync(['node', 'koda', 'auth', 'me', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(user, null, 2));
    });

    it('exits non-zero on API error', async () => {
      mockMe.mockRejectedValue({ ret: 40000, message: 'Unauthorized' });

      await program.parseAsync(['node', 'koda', 'auth', 'me']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('register', () => {
    it('registers a user and prints success', async () => {
      const user = { id: 'u-2', email: 'new@example.com' };
      mockRegister.mockResolvedValue({ ret: 0, data: user });

      await program.parseAsync(['node', 'koda', 'auth', 'register', '--email', 'new@example.com', '--password', 'Str0ng!Pass']);

      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ email: 'new@example.com', password: 'Str0ng!Pass' }),
      }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const user = { id: 'u-2', email: 'new@example.com' };
      mockRegister.mockResolvedValue({ ret: 0, data: user });

      await program.parseAsync(['node', 'koda', 'auth', 'register', '--email', 'new@example.com', '--password', 'Str0ng!Pass', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(user, null, 2));
    });

    it('passes optional name field', async () => {
      mockRegister.mockResolvedValue({ ret: 0, data: { id: 'u-3', email: 'a@b.com' } });

      await program.parseAsync(['node', 'koda', 'auth', 'register', '--email', 'a@b.com', '--password', 'Str0ng!1', '--name', 'Bob']);

      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ name: 'Bob' }),
      }));
    });
  });

  describe('logout', () => {
    it('sends logout and conditionally clears the used local credential', async () => {
      mockLogout.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync(['node', 'koda', 'auth', 'logout']);

      expect(mockLogout).toHaveBeenCalled();
      expect(mockClearUsedCredential).toHaveBeenCalledWith(CTX);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('describes the accepted request and local action without claiming universal revocation', async () => {
      mockLogout.mockResolvedValue({ ret: 0, data: {} });
      mockClearUsedCredential.mockReturnValue({ profileName: 'staging' });

      await program.parseAsync(['node', 'koda', 'auth', 'logout']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Logout request accepted'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('profile "staging"'));
      expect(logSpy.mock.calls.flat().join(' ')).not.toMatch(/revoke all|outstanding tokens|sk-test/i);
    });

    it('does not promise universal revocation in Commander help', () => {
      const auth = program.commands.find((command) => command.name() === 'auth');
      const logout = auth?.commands.find((command) => command.name() === 'logout');
      expect(auth).toBeDefined();
      expect(logout).toBeDefined();
      expect(logout?.description()).toContain('logout request');
      expect(logout?.description()).not.toMatch(/all outstanding|revoke/i);
    });

    it('outputs JSON when --json is set', async () => {
      mockLogout.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync(['node', 'koda', 'auth', 'logout', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ success: true }, null, 2));
    });

    it('exits non-zero on API error and does not clear local credentials', async () => {
      mockLogout.mockRejectedValue({ ret: 40000, message: 'Unauthorized' });

      await program.parseAsync(['node', 'koda', 'auth', 'logout']);

      expect(mockClearUsedCredential).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});
