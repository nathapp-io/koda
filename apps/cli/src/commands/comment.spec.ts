import { Command } from 'commander';
import { commentCommand } from './comment';
import * as configModule from '../config';
import * as clientModule from '../client';
import { CommentsService } from '../generated';

jest.mock('../config');
jest.mock('../client');
jest.mock('../generated', () => ({
  CommentsService: {
    create: jest.fn(),
  },
}));

describe('comment command', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('comment add', () => {
    it('registers comment add subcommand', () => {
      commentCommand(program);

      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment');
      const addCmd = commentCmd?.commands.find((cmd) => cmd.name() === 'add');
      expect(addCmd).toBeDefined();
    });

    it('adds a comment and prints success message', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-1',
          body: 'Looks good',
          type: 'GENERAL',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync(['node', 'koda', 'comment', 'add', 'KODA-1', '--body', 'Looks good']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('success'));
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('adds a comment with VERIFICATION type', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-1',
          body: 'Looks good',
          type: 'VERIFICATION',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync([
        'node',
        'koda',
        'comment',
        'add',
        'KODA-1',
        '--body',
        'Looks good',
        '--type',
        'verification',
      ]);

      expect(CommentsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: {
            ticketRef: 'KODA-1',
            body: 'Looks good',
            type: 'VERIFICATION',
          },
        })
      );
    });

    it('adds a comment with FIX_REPORT type', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-1',
          body: 'Fix applied',
          type: 'FIX_REPORT',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync([
        'node',
        'koda',
        'comment',
        'add',
        'KODA-1',
        '--body',
        'Fix applied',
        '--type',
        'fix_report',
      ]);

      expect(CommentsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: {
            ticketRef: 'KODA-1',
            body: 'Fix applied',
            type: 'FIX_REPORT',
          },
        })
      );
    });

    it('adds a comment with REVIEW type', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-1',
          body: 'Approved',
          type: 'REVIEW',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync([
        'node',
        'koda',
        'comment',
        'add',
        'KODA-1',
        '--body',
        'Approved',
        '--type',
        'review',
      ]);

      expect(CommentsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: {
            ticketRef: 'KODA-1',
            body: 'Approved',
            type: 'REVIEW',
          },
        })
      );
    });

    it('adds a comment with default GENERAL type', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-1',
          body: 'Just a comment',
          type: 'GENERAL',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync(['node', 'koda', 'comment', 'add', 'KODA-1', '--body', 'Just a comment']);

      expect(CommentsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: {
            ticketRef: 'KODA-1',
            body: 'Just a comment',
            type: 'GENERAL',
          },
        })
      );
    });

    it('accepts ticket ref in KODA-42 format', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-42',
          body: 'Found the issue',
          type: 'GENERAL',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync([
        'node',
        'koda',
        'comment',
        'add',
        'KODA-42',
        '--body',
        'Found the issue',
      ]);

      expect(CommentsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: expect.objectContaining({
            ticketRef: 'KODA-42',
          }),
        })
      );
    });

    it('requires ticket ref argument', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;

      expect(() => {
        addCmd.parse(['node', 'koda', 'comment', 'add']);
      }).toThrow();
    });

    it('requires --body flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;

      expect(() => {
        addCmd.parse(['node', 'koda', 'comment', 'add', 'KODA-1']);
      }).toThrow();
    });

    it('calls CommentsService.create with configured client', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: 'comment-123',
          ticketId: 'KODA-1',
          body: 'Test comment',
          type: 'GENERAL',
          createdAt: '2026-03-18T12:00:00Z',
        },
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync(['node', 'koda', 'comment', 'add', 'KODA-1', '--body', 'Test comment']);

      expect(clientModule.configureClient).toHaveBeenCalledWith(
        'http://localhost:3100/api',
        'test-key'
      );
      expect(CommentsService.create).toHaveBeenCalled();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync(['node', 'koda', 'comment', 'add', 'KODA-1', '--body', 'Test comment']);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 1 on API error', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (CommentsService.create as jest.Mock).mockRejectedValue(new Error('API error'));

      commentCommand(program);
      const commentCmd = program.commands.find((cmd) => cmd.name() === 'comment')!;
      const addCmd = commentCmd.commands.find((cmd) => cmd.name() === 'add')!;
      await addCmd.parseAsync(['node', 'koda', 'comment', 'add', 'KODA-1', '--body', 'Test comment']);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
