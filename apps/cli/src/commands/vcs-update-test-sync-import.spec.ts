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

// Mock generated API client
jest.mock('../generated/services.gen', () => ({
  vcsControllerUpdateConnection: jest.fn(),
  vcsControllerTestConnection: jest.fn(),
  vcsControllerSyncAll: jest.fn(),
  vcsControllerSyncIssue: jest.fn(),
  vcsControllerSyncPr: jest.fn(),
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
  resolveContext: jest.fn(async (flags: any) => ({
    projectSlug: flags.projectSlug || mockData.projectSlug,
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
  vcsControllerUpdateConnection,
  vcsControllerTestConnection,
  vcsControllerSyncAll,
  vcsControllerSyncIssue,
} from '../generated/services.gen';

describe('vcsCommand - update, test, sync, import', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    vcsCommand(program);

    // Setup default config
    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100';
    mockData.projectSlug = 'my-project';

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
    (vcsControllerUpdateConnection as jest.Mock).mockReset();
    (vcsControllerTestConnection as jest.Mock).mockReset();
    (vcsControllerSyncAll as jest.Mock).mockReset();
    (vcsControllerSyncIssue as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('vcs update', () => {
    it('calls PATCH /projects/:slug/vcs with sync-mode and authors flags', async () => {
      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'webhook',
        allowedAuthors: ['user1', 'user2'],
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerUpdateConnection as jest.Mock).mockResolvedValue(mockConnection);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const updateCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync([
        'node',
        'test',
        '--sync-mode',
        'webhook',
        '--authors',
        'user1,user2',
      ]);

      expect(vcsControllerUpdateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
          requestBody: expect.objectContaining({
            syncMode: 'webhook',
            allowedAuthors: ['user1', 'user2'],
          }),
        })
      );
    });

    it('calls PATCH with only sync-mode when authors not provided', async () => {
      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'webhook',
        allowedAuthors: [],
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerUpdateConnection as jest.Mock).mockResolvedValue(mockConnection);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const updateCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync(['node', 'test', '--sync-mode', 'webhook']);

      expect(vcsControllerUpdateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
          requestBody: expect.objectContaining({
            syncMode: 'webhook',
          }),
        })
      );
    });

    it('calls PATCH with only authors when sync-mode not provided', async () => {
      const mockConnection = {
        id: 'conn-1',
        projectId: 'proj-1',
        provider: 'github',
        repoOwner: 'octocat',
        repoName: 'Hello-World',
        syncMode: 'polling',
        allowedAuthors: ['user1', 'user2'],
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerUpdateConnection as jest.Mock).mockResolvedValue(mockConnection);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const updateCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync(['node', 'test', '--authors', 'user1,user2']);

      expect(vcsControllerUpdateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
          requestBody: expect.objectContaining({
            allowedAuthors: ['user1', 'user2'],
          }),
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
        syncMode: 'webhook',
        allowedAuthors: ['user1', 'user2'],
        pollingIntervalMs: 3600000,
        isActive: true,
        createdAt: new Date('2026-04-06T10:00:00Z'),
        updatedAt: new Date('2026-04-06T10:00:00Z'),
      };

      (vcsControllerUpdateConnection as jest.Mock).mockResolvedValue(mockConnection);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const updateCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync([
        'node',
        'test',
        '--project',
        'another-project',
        '--sync-mode',
        'webhook',
        '--authors',
        'user1,user2',
      ]);

      expect(vcsControllerUpdateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
        })
      );
    });

    it('handles network errors and exits with code 1', async () => {
      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerUpdateConnection as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const updateCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync([
        'node',
        'test',
        '--sync-mode',
        'webhook',
        '--authors',
        'user1,user2',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const updateCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync([
        'node',
        'test',
        '--sync-mode',
        'webhook',
        '--authors',
        'user1,user2',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('vcs test', () => {
    it('calls POST /projects/:slug/vcs/test and prints "Connection OK" on success', async () => {
      (vcsControllerTestConnection as jest.Mock).mockResolvedValue({
        ok: true,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const testCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'test');

      await testCmd?.parseAsync(['node', 'test']);

      expect(vcsControllerTestConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
        })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Connection OK'));
    });

    it('prints the provider error message and exits 1 when connection fails', async () => {
      (vcsControllerTestConnection as jest.Mock).mockResolvedValue({
        ok: false,
        error: 'Authentication failed: invalid token',
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const testCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'test');

      await testCmd?.parseAsync(['node', 'test']);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Authentication failed: invalid token')
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('resolves project slug from --project flag', async () => {
      (vcsControllerTestConnection as jest.Mock).mockResolvedValue({
        ok: true,
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const testCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'test');

      await testCmd?.parseAsync(['node', 'test', '--project', 'another-project']);

      expect(vcsControllerTestConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
        })
      );
    });

    it('handles network errors and exits with code 1', async () => {
      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerTestConnection as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const testCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'test');

      await testCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const testCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'test');

      await testCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('vcs sync', () => {
    it('calls POST /projects/:slug/vcs/sync and prints SyncResultDto summary', async () => {
      (vcsControllerSyncAll as jest.Mock).mockResolvedValue({
        issuesSynced: 5,
        issuesSkipped: 2,
        tickets: [],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test']);

      expect(vcsControllerSyncAll).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
        })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('5'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2'));
    });

    it('prints created count in summary', async () => {
      (vcsControllerSyncAll as jest.Mock).mockResolvedValue({
        issuesSynced: 10,
        issuesSkipped: 0,
        tickets: [],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('10'));
    });

    it('prints updated count in summary', async () => {
      (vcsControllerSyncAll as jest.Mock).mockResolvedValue({
        issuesSynced: 7,
        issuesSkipped: 0,
        tickets: [],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('7'));
    });

    it('prints skipped count in summary', async () => {
      (vcsControllerSyncAll as jest.Mock).mockResolvedValue({
        issuesSynced: 0,
        issuesSkipped: 4,
        tickets: [],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('4'));
    });

    it('resolves project slug from --project flag', async () => {
      (vcsControllerSyncAll as jest.Mock).mockResolvedValue({
        issuesSynced: 5,
        issuesSkipped: 2,
        tickets: [],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test', '--project', 'another-project']);

      expect(vcsControllerSyncAll).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
        })
      );
    });

    it('handles network errors and exits with code 1', async () => {
      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerSyncAll as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const syncCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'sync');

      await syncCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('vcs import', () => {
    it('calls POST /projects/:slug/vcs/sync/:issueNumber with issue number and prints ticket ref', async () => {
      (vcsControllerSyncIssue as jest.Mock).mockResolvedValue({
        issuesSynced: 1,
        issuesSkipped: 0,
        tickets: [{ ref: 'PROJ-123', title: 'Issue 42' }],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '42']);

      expect(vcsControllerSyncIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'my-project',
          issueNumber: '42',
        })
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PROJ-123'));
    });

    it('prints the created ticket ref on success', async () => {
      (vcsControllerSyncIssue as jest.Mock).mockResolvedValue({
        issuesSynced: 1,
        issuesSkipped: 0,
        tickets: [{ ref: 'MYPROJ-456', title: 'Issue 99' }],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '99']);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('MYPROJ-456'));
    });

    it('prints usage help and exits 1 when issue number is not provided', async () => {
      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('handles invalid issue number and exits 1', async () => {
      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', 'not-a-number']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('resolves project slug from --project flag', async () => {
      (vcsControllerSyncIssue as jest.Mock).mockResolvedValue({
        issuesSynced: 1,
        issuesSkipped: 0,
        tickets: [{ ref: 'PROJ-123', title: 'Issue 42' }],
      });

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '42', '--project', 'another-project']);

      expect(vcsControllerSyncIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'another-project',
          issueNumber: '42',
        })
      );
    });

    it('handles network errors and exits with code 1', async () => {
      const mockError = new Error('Network error');
      (mockError as any).response = { status: 500 };

      (vcsControllerSyncIssue as jest.Mock).mockRejectedValue(mockError);

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '42']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('exits 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const vcsCmd = program.commands.find((cmd) => cmd.name() === 'vcs');
      const importCmd = vcsCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '42']);

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});
