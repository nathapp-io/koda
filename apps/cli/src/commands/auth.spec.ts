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
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { authCommand } from './auth';
import { authControllerMe, authControllerRegister } from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockMe = authControllerMe as jest.Mock;
const mockRegister = authControllerRegister as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

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
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const user = { id: 'u-1', email: 'user@example.com', name: 'Alice', role: 'admin' };
      mockMe.mockResolvedValue({ ret: 0, data: user });

      await program.parseAsync(['node', 'koda', 'auth', 'me', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(user, null, 2));
    });

    it('exits non-zero on API error', async () => {
      mockMe.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

      await program.parseAsync(['node', 'koda', 'auth', 'me']);

      expect(exitSpy).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  describe('register', () => {
    it('registers a user and prints success', async () => {
      const user = { id: 'u-2', email: 'new@example.com' };
      mockRegister.mockResolvedValue({ ret: 0, data: user });

      await program.parseAsync(['node', 'koda', 'auth', 'register', '--email', 'new@example.com', '--password', 'Str0ng!Pass']);

      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({ email: 'new@example.com', password: 'Str0ng!Pass' }),
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
        requestBody: expect.objectContaining({ name: 'Bob' }),
      }));
    });
  });
});
