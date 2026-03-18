import { Command } from 'commander';
import { ticketCommand } from './ticket';
import * as configModule from '../config';
import * as clientModule from '../client';
import { TicketsService } from '../generated';

jest.mock('../config');
jest.mock('../client');
jest.mock('../generated', () => ({
  TicketsService: {
    create: jest.fn(),
    list: jest.fn(),
    show: jest.fn(),
    verify: jest.fn(),
    assign: jest.fn(),
    start: jest.fn(),
    fix: jest.fn(),
    verifyFix: jest.fn(),
    close: jest.fn(),
    reject: jest.fn(),
  },
}));

describe('ticket command', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe('ticket create', () => {
    it('registers ticket create subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');
      expect(createCmd).toBeDefined();
    });

    it('creates a ticket and prints KODA-N ref', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Test',
          type: 'BUG',
          projectSlug: 'koda',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;
      await createCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'create',
        '--project',
        'koda',
        '--type',
        'bug',
        '--title',
        'Test',
      ]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('KODA-42'));
    });

    it('requires --project flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;

      expect(() => {
        createCmd.parse([
          'node',
          'koda',
          'ticket',
          'create',
          '--type',
          'bug',
          '--title',
          'Test',
        ]);
      }).toThrow();
    });

    it('requires --type flag with bug or enhancement', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;

      expect(() => {
        createCmd.parse([
          'node',
          'koda',
          'ticket',
          'create',
          '--project',
          'koda',
          '--title',
          'Test',
        ]);
      }).toThrow();
    });

    it('requires --title flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;

      expect(() => {
        createCmd.parse([
          'node',
          'koda',
          'ticket',
          'create',
          '--project',
          'koda',
          '--type',
          'bug',
        ]);
      }).toThrow();
    });

    it('accepts optional --desc flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Test',
          description: 'Test description',
          type: 'BUG',
          projectSlug: 'koda',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;
      await createCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'create',
        '--project',
        'koda',
        '--type',
        'bug',
        '--title',
        'Test',
        '--desc',
        'Test description',
      ]);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: expect.objectContaining({
            description: 'Test description',
          }),
        })
      );
    });

    it('accepts optional --priority flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Test',
          type: 'BUG',
          priority: 'HIGH',
          projectSlug: 'koda',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;
      await createCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'create',
        '--project',
        'koda',
        '--type',
        'bug',
        '--title',
        'Test',
        '--priority',
        'high',
      ]);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: expect.objectContaining({
            priority: 'HIGH',
          }),
        })
      );
    });

    it('outputs JSON when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockTicket = {
        id: '1',
        number: 42,
        ref: 'KODA-42',
        title: 'Test',
        type: 'BUG',
        projectSlug: 'koda',
      };
      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;
      await createCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'create',
        '--project',
        'koda',
        '--type',
        'bug',
        '--title',
        'Test',
        '--json',
      ]);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toEqual(mockTicket);
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const createCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'create')!;
      await createCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'create',
        '--project',
        'koda',
        '--type',
        'bug',
        '--title',
        'Test',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket list', () => {
    it('registers ticket list subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');
      expect(listCmd).toBeDefined();
    });

    it('lists tickets in table format with columns', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [
          {
            id: '1',
            number: 42,
            ref: 'KODA-42',
            title: 'Null ref in auth service',
            type: 'BUG',
            priority: 'HIGH',
            status: 'VERIFIED',
            assignedToAgent: {
              slug: 'subrina-coder',
            },
          },
        ],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
      ]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('KODA-42'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('subrina-coder'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('VERIFIED'));
    });

    it('outputs valid JSON array when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockTickets = [
        {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Null ref in auth service',
          type: 'BUG',
          priority: 'HIGH',
          status: 'VERIFIED',
          assignedToAgent: {
            slug: 'subrina-coder',
          },
        },
      ];
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: mockTickets,
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--json',
      ]);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toHaveProperty('ref');
      expect(parsed[0].ref).toBe('KODA-42');
    });

    it('filters by status when --status flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--status',
        'verified',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            status: 'VERIFIED',
          }),
        })
      );
    });

    it('filters by type when --type flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--type',
        'bug',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            type: 'BUG',
          }),
        })
      );
    });

    it('filters by priority when --priority flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--priority',
        'high',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            priority: 'HIGH',
          }),
        })
      );
    });

    it('filters by assigned-to when --assigned-to flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--assigned-to',
        'subrina-coder',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            assignedToAgentSlug: 'subrina-coder',
          }),
        })
      );
    });

    it('filters unassigned when --unassigned flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--unassigned',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            unassigned: true,
          }),
        })
      );
    });

    it('supports limit and page pagination', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
        '--limit',
        '50',
        '--page',
        '2',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            limit: 50,
            page: 2,
          }),
        })
      );
    });

    it('requires --project flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;

      expect(() => {
        listCmd.parse(['node', 'koda', 'ticket', 'list']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const listCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'list')!;
      await listCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'list',
        '--project',
        'koda',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket mine', () => {
    it('registers ticket mine subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const mineCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'mine');
      expect(mineCmd).toBeDefined();
    });

    it('lists tickets assigned to current agent', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [
          {
            id: '1',
            number: 42,
            ref: 'KODA-42',
            title: 'Null ref in auth service',
            type: 'BUG',
            status: 'VERIFIED',
            assignedToAgent: {
              slug: 'current-agent',
            },
          },
        ],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const mineCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'mine')!;
      await mineCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'mine',
        '--project',
        'koda',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            assignedToAgentSlug: 'self',
          }),
        })
      );
    });

    it('outputs table when no --json flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [
          {
            id: '1',
            number: 42,
            ref: 'KODA-42',
            title: 'Test',
            type: 'BUG',
            status: 'VERIFIED',
            assignedToAgent: {
              slug: 'agent',
            },
          },
        ],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const mineCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'mine')!;
      await mineCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'mine',
        '--project',
        'koda',
      ]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('KODA-42'));
    });

    it('outputs JSON when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockTickets = [
        {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Test',
          type: 'BUG',
          status: 'VERIFIED',
        },
      ];
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: mockTickets,
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const mineCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'mine')!;
      await mineCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'mine',
        '--project',
        'koda',
        '--json',
      ]);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('filters by status when --status flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: [],
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const mineCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'mine')!;
      await mineCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'mine',
        '--project',
        'koda',
        '--status',
        'verified',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: expect.objectContaining({
            status: 'VERIFIED',
            assignedToAgentSlug: 'self',
          }),
        })
      );
    });

    it('requires --project flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const mineCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'mine')!;

      expect(() => {
        mineCmd.parse(['node', 'koda', 'ticket', 'mine']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const mineCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'mine')!;
      await mineCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'mine',
        '--project',
        'koda',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket show', () => {
    it('registers ticket show subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');
      expect(showCmd).toBeDefined();
    });

    it('displays ticket details with comments', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Null ref in auth service',
          description: 'NullPointerException in AuthService...',
          type: 'BUG',
          priority: 'HIGH',
          status: 'VERIFIED',
          createdByUser: {
            email: 'william@example.com',
          },
          assignedToAgent: {
            slug: 'subrina-coder',
          },
          comments: [
            {
              id: 'c1',
              type: 'VERIFICATION',
              createdByAgent: {
                slug: 'subrina-coder',
              },
              text: 'Confirmed: null ref at src/auth/auth.service.ts:87',
              createdAt: '2026-03-17',
            },
          ],
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const showCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'show',
        'KODA-42',
      ]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('KODA-42'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Null ref in auth service'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('BUG'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('HIGH'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('VERIFIED'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('subrina-coder'));
    });

    it('displays comments with type and agent info', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Test',
          type: 'BUG',
          status: 'VERIFIED',
          createdByUser: {
            email: 'user@example.com',
          },
          comments: [
            {
              id: 'c1',
              type: 'VERIFICATION',
              createdByAgent: {
                slug: 'subrina-coder',
              },
              text: 'Confirmed',
              createdAt: '2026-03-17',
            },
          ],
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const showCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'show',
        'KODA-42',
      ]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('VERIFICATION'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('subrina-coder'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Confirmed'));
    });

    it('outputs JSON when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockTicket = {
        id: '1',
        number: 42,
        ref: 'KODA-42',
        title: 'Test',
        type: 'BUG',
      };
      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const showCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'show',
        'KODA-42',
        '--json',
      ]);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toEqual(mockTicket);
    });

    it('accepts KODA-42 style ref', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          number: 42,
          ref: 'KODA-42',
          title: 'Test',
          type: 'BUG',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const showCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'show',
        'KODA-42',
      ]);

      expect(TicketsService.show).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
        })
      );
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const showCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'show')!;

      expect(() => {
        showCmd.parse(['node', 'koda', 'ticket', 'show']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const showCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'show')!;
      await showCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'show',
        'KODA-42',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket verify', () => {
    it('registers ticket verify subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify');
      expect(verifyCmd).toBeDefined();
    });

    it('sends verification with comment and prints success', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.verify as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'VERIFIED',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify')!;
      await verifyCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'verify',
        'KODA-42',
        '--comment',
        'Confirmed',
      ]);

      expect(TicketsService.verify).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
          body: expect.objectContaining({
            text: 'Confirmed',
          }),
        })
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('success'));
    });

    it('requires --comment flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify')!;

      expect(() => {
        verifyCmd.parse(['node', 'koda', 'ticket', 'verify', 'KODA-42']);
      }).toThrow();
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify')!;

      expect(() => {
        verifyCmd.parse(['node', 'koda', 'ticket', 'verify']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify')!;
      await verifyCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'verify',
        'KODA-42',
        '--comment',
        'Confirmed',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket assign', () => {
    it('registers ticket assign subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const assignCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'assign');
      expect(assignCmd).toBeDefined();
    });

    it('assigns ticket to specified agent', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.assign as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          assignedToAgent: {
            slug: 'subrina-coder',
          },
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const assignCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'assign')!;
      await assignCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'assign',
        'KODA-42',
        '--to',
        'subrina-coder',
      ]);

      expect(TicketsService.assign).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
          body: expect.objectContaining({
            agentSlug: 'subrina-coder',
          }),
        })
      );
    });

    it('self-assigns when --to flag is omitted', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.assign as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          assignedToAgent: {
            slug: 'self',
          },
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const assignCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'assign')!;
      await assignCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'assign',
        'KODA-42',
      ]);

      expect(TicketsService.assign).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: expect.objectContaining({
            agentSlug: 'self',
          }),
        })
      );
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const assignCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'assign')!;

      expect(() => {
        assignCmd.parse(['node', 'koda', 'ticket', 'assign']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const assignCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'assign')!;
      await assignCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'assign',
        'KODA-42',
        '--to',
        'subrina-coder',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket start', () => {
    it('registers ticket start subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const startCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'start');
      expect(startCmd).toBeDefined();
    });

    it('transitions ticket to IN_PROGRESS', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.start as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'IN_PROGRESS',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const startCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'start')!;
      await startCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'start',
        'KODA-42',
      ]);

      expect(TicketsService.start).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
        })
      );
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const startCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'start')!;

      expect(() => {
        startCmd.parse(['node', 'koda', 'ticket', 'start']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const startCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'start')!;
      await startCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'start',
        'KODA-42',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket fix', () => {
    it('registers ticket fix subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const fixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'fix');
      expect(fixCmd).toBeDefined();
    });

    it('sends fix report with comment', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.fix as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'VERIFY_FIX',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const fixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'fix')!;
      await fixCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'fix',
        'KODA-42',
        '--comment',
        'Fixed',
      ]);

      expect(TicketsService.fix).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
          body: expect.objectContaining({
            text: 'Fixed',
          }),
        })
      );
    });

    it('accepts optional --git-ref flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.fix as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'VERIFY_FIX',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const fixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'fix')!;
      await fixCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'fix',
        'KODA-42',
        '--comment',
        'Fixed',
        '--git-ref',
        'v1.0:src/auth.ts:42',
      ]);

      expect(TicketsService.fix).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: expect.objectContaining({
            gitRef: 'v1.0:src/auth.ts:42',
          }),
        })
      );
    });

    it('requires --comment flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const fixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'fix')!;

      expect(() => {
        fixCmd.parse(['node', 'koda', 'ticket', 'fix', 'KODA-42']);
      }).toThrow();
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const fixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'fix')!;

      expect(() => {
        fixCmd.parse(['node', 'koda', 'ticket', 'fix']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const fixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'fix')!;
      await fixCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'fix',
        'KODA-42',
        '--comment',
        'Fixed',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket verify-fix', () => {
    it('registers ticket verify-fix subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');
      expect(verifyFixCmd).toBeDefined();
    });

    it('sends verification with --pass flag closes ticket', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.verifyFix as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'CLOSED',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyFixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify-fix')!;
      await verifyFixCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'verify-fix',
        'KODA-42',
        '--comment',
        'Pass',
        '--pass',
      ]);

      expect(TicketsService.verifyFix).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
          body: expect.objectContaining({
            approved: true,
          }),
        })
      );
    });

    it('sends verification with --fail flag returns to IN_PROGRESS', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.verifyFix as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'IN_PROGRESS',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyFixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify-fix')!;
      await verifyFixCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'verify-fix',
        'KODA-42',
        '--comment',
        'Fail',
        '--fail',
      ]);

      expect(TicketsService.verifyFix).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          body: expect.objectContaining({
            approved: false,
          }),
        })
      );
    });

    it('requires --comment flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyFixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify-fix')!;

      expect(() => {
        verifyFixCmd.parse(['node', 'koda', 'ticket', 'verify-fix', 'KODA-42']);
      }).toThrow();
    });

    it('requires --pass or --fail flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyFixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify-fix')!;

      expect(() => {
        verifyFixCmd.parse([
          'node',
          'koda',
          'ticket',
          'verify-fix',
          'KODA-42',
          '--comment',
          'Test',
        ]);
      }).toThrow();
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyFixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify-fix')!;

      expect(() => {
        verifyFixCmd.parse(['node', 'koda', 'ticket', 'verify-fix']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const verifyFixCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'verify-fix')!;
      await verifyFixCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'verify-fix',
        'KODA-42',
        '--comment',
        'Test',
        '--pass',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket close', () => {
    it('registers ticket close subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const closeCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'close');
      expect(closeCmd).toBeDefined();
    });

    it('closes the ticket', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.close as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'CLOSED',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const closeCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'close')!;
      await closeCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'close',
        'KODA-42',
      ]);

      expect(TicketsService.close).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
        })
      );
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const closeCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'close')!;

      expect(() => {
        closeCmd.parse(['node', 'koda', 'ticket', 'close']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const closeCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'close')!;
      await closeCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'close',
        'KODA-42',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket reject', () => {
    it('registers ticket reject subcommand', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const rejectCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'reject');
      expect(rejectCmd).toBeDefined();
    });

    it('rejects ticket with comment', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (TicketsService.reject as jest.Mock).mockResolvedValue({
        data: {
          id: '1',
          ref: 'KODA-42',
          status: 'REJECTED',
        },
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const rejectCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'reject')!;
      await rejectCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'reject',
        'KODA-42',
        '--comment',
        'Reason',
      ]);

      expect(TicketsService.reject).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          path: expect.objectContaining({
            ref: 'KODA-42',
          }),
          body: expect.objectContaining({
            text: 'Reason',
          }),
        })
      );
    });

    it('requires --comment flag', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const rejectCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'reject')!;

      expect(() => {
        rejectCmd.parse(['node', 'koda', 'ticket', 'reject', 'KODA-42']);
      }).toThrow();
    });

    it('requires ref argument', () => {
      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const rejectCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'reject')!;

      expect(() => {
        rejectCmd.parse(['node', 'koda', 'ticket', 'reject']);
      }).toThrow();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      ticketCommand(program);
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket')!;
      const rejectCmd = ticketCmd.commands.find((cmd) => cmd.name() === 'reject')!;
      await rejectCmd.parseAsync([
        'node',
        'koda',
        'ticket',
        'reject',
        'KODA-42',
        '--comment',
        'Reason',
      ]);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });
});
