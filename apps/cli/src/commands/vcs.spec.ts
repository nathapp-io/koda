// Mock chalk early to prevent ESM issues
jest.mock('chalk', () => {
  const mockChalk = {
    cyan: { bold: (str: string) => str },
    gray: (str: string) => str,
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
  };
  return mockChalk;
});

// Mock conf before importing
const mockData: Record<string, string> = {};

const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => {
    mockData[key] = value;
  }),
};

jest.mock('conf', () => {
  return jest.fn(() => mockStore);
});

// Mock the generated client using stubs
jest.mock('../vcs-client.stub', () => ({
  vcsControllerCreateConnection: jest.fn(),
  vcsControllerGetConnection: jest.fn(),
  vcsControllerDeleteConnection: jest.fn(),
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

// Mock config module
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
  })),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4);
  }),
}));

import { Command } from 'commander';
import { vcsCommand } from './vcs';
import {
  vcsControllerCreateConnection,
  vcsControllerGetConnection,
  vcsControllerDeleteConnection,
} from '../vcs-client.stub';

describe('vcsCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    vcsCommand(program);

    // Setup default config
    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    // Clear environment variables
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;
    delete process.env.KODA_PROJECT_SLUG;

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Don't throw, just record the call
    }) as any);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.clearAllMocks();
    (vcsControllerCreateConnection as jest.Mock).mockReset();
    (vcsControllerGetConnection as jest.Mock).mockReset();
    (vcsControllerDeleteConnection as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('vcs connect', () => {
    it('connects with required flags and prints connection info', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--provider',
        'github',
        '--owner',
        'octocat',
        '--repo',
        'Hello-World',
        '--token',
        'gh_test_token_1234567890',
        '--sync-mode',
        'polling',
      ]);

      expect(vcsControllerCreateConnection).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('github'));
    });

    it('outputs JSON with --json flag', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--provider',
        'github',
        '--owner',
        'octocat',
        '--repo',
        'Hello-World',
        '--token',
        'gh_test_token_1234567890',
        '--sync-mode',
        'polling',
        '--json',
      ]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"provider"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"repoOwner"'));
    });

    it('resolves project slug from local config if not provided', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--provider',
        'github',
        '--owner',
        'octocat',
        '--repo',
        'Hello-World',
        '--token',
        'gh_test_token_1234567890',
        '--sync-mode',
        'polling',
      ]);

      expect(vcsControllerCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
        })
      );
    });

    it('resolves project slug from --project flag', async () => {
      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerCreateConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--project',
        'another-project',
        '--provider',
        'github',
        '--owner',
        'octocat',
        '--repo',
        'Hello-World',
        '--token',
        'gh_test_token_1234567890',
        '--sync-mode',
        'polling',
      ]);

      expect(vcsControllerCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
        })
      );
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';
      mockData.projectSlug = 'my-project';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--provider',
        'github',
        '--owner',
        'octocat',
        '--repo',
        'Hello-World',
        '--token',
        'gh_test_token_1234567890',
        '--sync-mode',
        'polling',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles network errors and exits with code 1', async () => {
      mockData.projectSlug = 'my-project';

      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerCreateConnection as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--provider',
        'github',
        '--owner',
        'octocat',
        '--repo',
        'Hello-World',
        '--token',
        'gh_test_token_1234567890',
        '--sync-mode',
        'polling',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 3 when required flags are missing', async () => {
      mockData.projectSlug = 'my-project';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const connectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'connect');

      await connectCmd?.parseAsync([
        'node',
        'test',
        '--provider',
        'github',
        // Missing --owner, --repo, --token
      ]);

      expect(exitSpy).toHaveBeenCalledWith(3);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('vcs status', () => {
    it('fetches and displays VCS connection status', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        lastSyncedAt: new Date('2026-04-06T09:00:00Z'),
        createdAt: new Date('2026-04-06T08:00:00Z'),
        updatedAt: new Date('2026-04-06T09:00:00Z'),
      };

      (vcsControllerGetConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test']);

      expect(vcsControllerGetConnection).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('github'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('octocat'));
    });

    it('prints last sync time when available', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        lastSyncedAt: new Date('2026-04-06T09:00:00Z'),
        createdAt: new Date('2026-04-06T08:00:00Z'),
        updatedAt: new Date('2026-04-06T09:00:00Z'),
      };

      (vcsControllerGetConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/last.*sync|sync.*time/i));
    });

    it('outputs JSON with --json flag', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        lastSyncedAt: new Date('2026-04-06T09:00:00Z'),
        createdAt: new Date('2026-04-06T08:00:00Z'),
        updatedAt: new Date('2026-04-06T09:00:00Z'),
      };

      (vcsControllerGetConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test', '--json']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"provider"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"lastSyncedAt"'));
    });

    it('prints "No VCS connection configured" when none exists', async () => {
      mockData.projectSlug = 'my-project';

      const mockError = new Error('Not found');
      (mockError as any).response = { status: 404 };

      (vcsControllerGetConnection as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test']);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No VCS connection configured')
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('resolves project slug from local config if not provided', async () => {
      mockData.projectSlug = 'my-project';

      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        lastSyncedAt: new Date('2026-04-06T09:00:00Z'),
        createdAt: new Date('2026-04-06T08:00:00Z'),
        updatedAt: new Date('2026-04-06T09:00:00Z'),
      };

      (vcsControllerGetConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test']);

      expect(vcsControllerGetConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
        })
      );
    });

    it('resolves project slug from --project flag', async () => {
      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: '',
        pollingIntervalMs: 3600000,
        isActive: true,
        lastSyncedAt: new Date('2026-04-06T09:00:00Z'),
        createdAt: new Date('2026-04-06T08:00:00Z'),
        updatedAt: new Date('2026-04-06T09:00:00Z'),
      };

      (vcsControllerGetConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: mockConnection,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test', '--project', 'another-project']);

      expect(vcsControllerGetConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
        })
      );
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';
      mockData.projectSlug = 'my-project';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles network errors and exits with code 1', async () => {
      mockData.projectSlug = 'my-project';

      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerGetConnection as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const statusCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'status');

      await statusCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('vcs disconnect', () => {
    it('disconnects and prints confirmation message', async () => {
      mockData.projectSlug = 'my-project';

      (vcsControllerDeleteConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {},
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const disconnectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'disconnect');

      await disconnectCmd?.parseAsync(['node', 'test']);

      expect(vcsControllerDeleteConnection).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/disconnect|removed/i));
    });

    it('resolves project slug from local config if not provided', async () => {
      mockData.projectSlug = 'my-project';

      (vcsControllerDeleteConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {},
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const disconnectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'disconnect');

      await disconnectCmd?.parseAsync(['node', 'test']);

      expect(vcsControllerDeleteConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
        })
      );
    });

    it('resolves project slug from --project flag', async () => {
      (vcsControllerDeleteConnection as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {},
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const disconnectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'disconnect');

      await disconnectCmd?.parseAsync(['node', 'test', '--project', 'another-project']);

      expect(vcsControllerDeleteConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
        })
      );
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';
      mockData.projectSlug = 'my-project';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const disconnectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'disconnect');

      await disconnectCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles network errors and exits with code 1', async () => {
      mockData.projectSlug = 'my-project';

      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerDeleteConnection as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const disconnectCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'disconnect');

      await disconnectCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
