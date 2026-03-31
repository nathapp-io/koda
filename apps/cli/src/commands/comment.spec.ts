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

// Mock the generated client
jest.mock('../generated', () => ({
  commentsControllerCreateFromHttp: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

// Mock config module to use mockData instead of real filesystem
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
  })),
  resolveContext: jest.fn((flags: { projectSlug?: string }) =>
    Promise.resolve({
      projectSlug: flags.projectSlug || 'koda',
      apiKey: mockData.apiKey || '',
      apiUrl: mockData.apiUrl || '',
    })
  ),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4);
  }),
}));

import { Command } from 'commander';
import { commentCommand } from './comment';
import { commentsControllerCreateFromHttp } from '../generated';

describe('commentCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    commentCommand(program);

    // Setup default config
    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Don't throw, just record the call
    }) as any);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.clearAllMocks();
    (commentsControllerCreateFromHttp as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('comment add', () => {
    it('posts comment with required fields using default GENERAL type', async () => {
      const mockComment = {
        id: 'comment-1',
        body: 'Test comment',
        type: 'GENERAL',
        ticketId: 'ticket-1',
        createdAt: new Date().toISOString(),
      };

      (commentsControllerCreateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockComment });

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', 'KODA-42', '--body', 'Test comment']).catch(() => undefined);

      expect(commentsControllerCreateFromHttp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'koda',
          ref: 'KODA-42',
          requestBody: expect.objectContaining({
            body: 'Test comment',
            type: 'GENERAL',
          }),
        })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('posts comment with explicit uppercase type FIX_REPORT', async () => {
      const mockComment = {
        id: 'comment-1',
        body: 'Fix report',
        type: 'FIX_REPORT',
        ticketId: 'ticket-1',
        createdAt: new Date().toISOString(),
      };

      (commentsControllerCreateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockComment });

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync([
        'node',
        'test',
        'KODA-42',
        '--body',
        'Fix report',
        '--type',
        'FIX_REPORT',
      ]).catch(() => undefined);

      expect(commentsControllerCreateFromHttp).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'koda',
          ref: 'KODA-42',
          requestBody: expect.objectContaining({
            body: 'Fix report',
            type: 'FIX_REPORT',
          }),
        })
      );
    });

    it('exits with code 3 when --type is lowercase general', async () => {
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', 'KODA-42', '--body', 'Test comment', '--type', 'general']).catch(() => undefined);

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('supports all uppercase comment types', async () => {
      const types = ['VERIFICATION', 'FIX_REPORT', 'REVIEW', 'GENERAL'];

      for (const type of types) {
        const mockComment = {
          id: 'comment-1',
          body: `${type} comment`,
          type,
          ticketId: 'ticket-1',
          createdAt: new Date().toISOString(),
        };

        (commentsControllerCreateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockComment });

        const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
        const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

        await addCmd?.parseAsync([
          'node',
          'test',
          'KODA-42',
          '--body',
          `${type} comment`,
          '--type',
          type,
        ]).catch(() => undefined);

        expect(commentsControllerCreateFromHttp).toHaveBeenCalledWith(
          expect.objectContaining({
            slug: 'koda',
            ref: 'KODA-42',
            requestBody: expect.objectContaining({ type }),
          })
        );
      }
    });

    it('returns JSON with --json flag', async () => {
      const mockComment = {
        id: 'comment-1',
        body: 'Test comment',
        type: 'GENERAL',
        ticketId: 'ticket-1',
        createdAt: new Date().toISOString(),
      };

      (commentsControllerCreateFromHttp as jest.Mock).mockResolvedValue({ ret: 0, data: mockComment });

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync([
          'node',
          'test',
          'KODA-42',
          '--body',
          'Test comment',
          '--json',
        ]).catch(() => undefined);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('comment-1'));
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', 'KODA-42', '--body', 'Test comment']).catch(() => undefined);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (commentsControllerCreateFromHttp as jest.Mock).mockRejectedValue(mockError);

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', 'KODA-42', '--body', 'Test comment']).catch(() => undefined);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on unauthorized error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 401 };

      (commentsControllerCreateFromHttp as jest.Mock).mockRejectedValue(mockError);

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', 'KODA-42', '--body', 'Test comment']).catch(() => undefined);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});
