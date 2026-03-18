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

// Mock axios client
const mockAxios = {
  get: jest.fn(),
  post: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: () => mockAxios,
  };
});

// Mock the generated client
jest.mock('../generated', () => ({
  CommentsService: {
    add: jest.fn(),
  },
}));

import { Command } from 'commander';
import { commentCommand } from './comment';
import { CommentsService } from '../generated';

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('comment add', () => {
    it('posts comment with required fields', async () => {
      const mockComment = {
        id: 'comment-1',
        body: 'Test comment',
        type: 'general',
        ticketId: 'ticket-1',
        createdAt: new Date().toISOString(),
      };

      (CommentsService.add as jest.Mock).mockResolvedValue({
        data: mockComment,
      });

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parse(['node', 'test', 'KODA-42', '--body', 'Test comment']);

      expect(CommentsService.add).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-42',
        expect.objectContaining({
          body: 'Test comment',
          type: 'general',
        })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('posts comment with explicit type', async () => {
      const mockComment = {
        id: 'comment-1',
        body: 'Fix report',
        type: 'fix_report',
        ticketId: 'ticket-1',
        createdAt: new Date().toISOString(),
      };

      (CommentsService.add as jest.Mock).mockResolvedValue({
        data: mockComment,
      });

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parse([
        'node',
        'test',
        'KODA-42',
        '--body',
        'Fix report',
        '--type',
        'fix_report',
      ]);

      expect(CommentsService.add).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-42',
        expect.objectContaining({
          body: 'Fix report',
          type: 'fix_report',
        })
      );
    });

    it('supports all comment types', async () => {
      const types = ['verification', 'fix_report', 'review', 'general'];

      for (const type of types) {
        const mockComment = {
          id: 'comment-1',
          body: `${type} comment`,
          type,
          ticketId: 'ticket-1',
          createdAt: new Date().toISOString(),
        };

        (CommentsService.add as jest.Mock).mockResolvedValue({
          data: mockComment,
        });

        const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
        const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

        await addCmd?.parse([
          'node',
          'test',
          'KODA-42',
          '--body',
          `${type} comment`,
          '--type',
          type,
        ]);

        expect(CommentsService.add).toHaveBeenCalledWith(
          expect.any(Object),
          'KODA-42',
          expect.objectContaining({
            type,
          })
        );
      }
    });

    it('returns JSON with --json flag', async () => {
      const mockComment = {
        id: 'comment-1',
        body: 'Test comment',
        type: 'general',
        ticketId: 'ticket-1',
        createdAt: new Date().toISOString(),
      };

      (CommentsService.add as jest.Mock).mockResolvedValue({
        data: mockComment,
      });

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parse([
          'node',
          'test',
          'KODA-42',
          '--body',
          'Test comment',
          '--json',
        ]);
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
        await addCmd?.parse(['node', 'test', 'KODA-42', '--body', 'Test comment']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (CommentsService.add as jest.Mock).mockRejectedValue(mockError);

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parse(['node', 'test', 'KODA-42', '--body', 'Test comment']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on unauthorized error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 401 };

      (CommentsService.add as jest.Mock).mockRejectedValue(mockError);

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parse(['node', 'test', 'KODA-42', '--body', 'Test comment']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});
