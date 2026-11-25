jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s },
  gray: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
}));

const mockData: Record<string, unknown> = {};
const mockStore = {
  get: jest.fn((key: string) => key in mockData ? mockData[key] : key === 'profiles' ? {} : ''),
  set: jest.fn((key: string, value: unknown) => { mockData[key] = value; }),
};
jest.mock('conf', () => jest.fn(() => mockStore));

jest.mock('../generated', () => ({
  authControllerMe: jest.fn(),
  authControllerRegister: jest.fn(),
  authControllerLogout: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../config', () => {
  const actual = jest.requireActual('../config');
  return {
    ...actual,
    resolveContext: jest.fn(),
    clearUsedCredential: jest.fn(() => 'none'),
  };
});

jest.mock('../generated/client.gen', () => ({
  client: {
    setConfig: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
  },
}));

jest.mock('../utils/output', () => ({
  finishSuccess: jest.requireActual('../utils/output').finishSuccess,
  table: jest.fn(),
  error: jest.fn(),
}));

import { Command } from 'commander';
import { authCommand } from './auth';
import { authControllerMe, authControllerRegister, authControllerLogout } from '../generated';
import { resolveContext, clearUsedCredential } from '../config';
import { client } from '../generated/client.gen';
import { table } from '../utils/output';

const actualConfig = jest.requireActual<typeof import('../config')>('../config');

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
    Object.keys(mockData).forEach((key) => delete mockData[key]);
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;
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
    it.each([
      ['different', 'environment-key-12345'],
      ['equal to saved global key', 'saved-global-key-12345'],
    ])('uses the environment endpoint and bearer without mutating saved config when key is %s', async (_case, environmentKey) => {
      mockData.apiKey = 'saved-global-key-12345';
      mockData.apiUrl = 'https://deployment-a.example/base';
      process.env.KODA_API_KEY = environmentKey;
      process.env.KODA_API_URL = 'https://deployment-b.example/prefix/api';
      mockResolveContext.mockImplementation(actualConfig.resolveContext);
      mockClearUsedCredential.mockImplementation(actualConfig.clearUsedCredential);
      mockLogout.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync(['node', 'koda', 'auth', 'logout']);

      expect(mockLogout).toHaveBeenCalled();
      expect(client.setConfig).toHaveBeenCalledWith({
        baseUrl: 'https://deployment-b.example/prefix',
        headers: { Authorization: `Bearer ${environmentKey}` },
      });
      expect(mockData.apiKey).toBe('saved-global-key-12345');
      expect(mockData.apiUrl).toBe('https://deployment-a.example/base');
      expect(mockStore.set).not.toHaveBeenCalled();
    });

    it('accepts logout when the selected profile owning URL is unusable', async () => {
      mockData.apiKey = 'global-key-12345';
      mockData.apiUrl = 'https://global.example';
      mockData.profiles = { selected: { apiKey: 'profile-key-12345', apiUrl: 'not-a-url' } };
      process.env.KODA_API_URL = 'https://deployment-b.example';
      mockResolveContext.mockImplementation((flags: unknown) =>
        actualConfig.resolveContext((flags ?? {}) as never, {
          findProjectConfig: async () => ({ profile: 'selected' }),
          getConfig: actualConfig.getConfig,
        }),
      );
      mockClearUsedCredential.mockImplementation(actualConfig.clearUsedCredential);
      mockLogout.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync(['node', 'koda', 'auth', 'logout']);

      expect(mockLogout).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Logout request accepted'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No saved credential was cleared'));
      expect(mockData.profiles).toEqual({ selected: { apiKey: 'profile-key-12345', apiUrl: 'not-a-url' } });
      expect(mockData.apiKey).toBe('global-key-12345');
      expect(mockStore.set).not.toHaveBeenCalled();
    });

    it('accepts logout when the stored endpoint is replaced with an unusable URL mid-request', async () => {
      mockData.apiKey = 'saved-global-key-12345';
      mockData.apiUrl = 'https://deployment-a.example';
      mockResolveContext.mockImplementation(actualConfig.resolveContext);
      mockClearUsedCredential.mockImplementation(actualConfig.clearUsedCredential);
      mockLogout.mockImplementation(async () => {
        mockData.apiUrl = 'not-a-url';
        return { ret: 0, data: {} };
      });

      await program.parseAsync(['node', 'koda', 'auth', 'logout']);

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(mockData.apiKey).toBe('saved-global-key-12345');
      expect(mockData.apiUrl).toBe('not-a-url');
      expect(mockStore.set).not.toHaveBeenCalled();
    });

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
