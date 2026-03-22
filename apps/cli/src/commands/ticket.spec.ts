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
  patch: jest.fn(),
};

jest.mock('axios', () => {
  return {
    create: () => mockAxios,
  };
});

// Mock the generated client
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

import { Command } from 'commander';
import { ticketCommand } from './ticket';
import { TicketsService } from '../generated';

describe('ticketCommand', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    ticketCommand(program);

    // Setup default config
    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    // Clear environment variables
    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Don't throw, just record the call
    }) as any);

    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('ticket command registration', () => {
    it('registers ticket command', () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      expect(ticketCmd).toBeDefined();
    });

    it('has correct description', () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      expect(ticketCmd?.description()).toBe('Manage tickets');
    });

    it('registers all subcommands', () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      expect(ticketCmd).toBeDefined();

      const subcommands = ticketCmd?.commands.map((cmd) => cmd.name()) || [];
      const expectedSubcommands = [
        'create',
        'list',
        'mine',
        'show',
        'verify',
        'assign',
        'start',
        'fix',
        'verify-fix',
        'close',
        'reject',
        'open',
      ];

      expectedSubcommands.forEach((cmd) => {
        expect(subcommands).toContain(cmd);
      });
    });
  });

  describe('ticket create', () => {
    it('creates ticket with required options', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        projectId: 'proj-1',
        type: 'bug',
        title: 'Test bug',
        status: 'created',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--type',
        'bug',
        '--title',
        'Test bug',
      ]);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          projectSlug: 'test-project',
          type: 'bug',
          title: 'Test bug',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('creates ticket with optional description', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        projectId: 'proj-1',
        type: 'enhancement',
        title: 'New feature',
        description: 'Feature description',
        status: 'created',
        priority: 'high',
        createdAt: new Date().toISOString(),
      };

      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--type',
        'enhancement',
        '--title',
        'New feature',
        '--desc',
        'Feature description',
      ]);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          projectSlug: 'test-project',
          type: 'enhancement',
          title: 'New feature',
          description: 'Feature description',
        })
      );
    });

    it('creates ticket with priority option', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        projectId: 'proj-1',
        type: 'bug',
        title: 'Critical bug',
        status: 'created',
        priority: 'critical',
        createdAt: new Date().toISOString(),
      };

      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--type',
        'bug',
        '--title',
        'Critical bug',
        '--priority',
        'critical',
      ]);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          priority: 'critical',
        })
      );
    });

    it('returns JSON with --json flag', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        projectId: 'proj-1',
        type: 'bug',
        title: 'Test bug',
        status: 'created',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      (TicketsService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      try {
        await createCmd?.parse([
          'node',
          'test',
          '--project',
          'test-project',
          '--type',
          'bug',
          '--title',
          'Test bug',
          '--json',
        ]);
      } catch {
        // Expected
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ticket-1'));
    });

    it('exits with code 3 when required options are missing', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      try {
        await createCmd?.parse([
          'node',
          'test',
          '--project',
          'test-project',
          '--type',
          'bug',
          // Missing --title
        ]);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      try {
        await createCmd?.parse([
          'node',
          'test',
          '--project',
          'test-project',
          '--type',
          'bug',
          '--title',
          'Test bug',
        ]);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (TicketsService.create as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      try {
        await createCmd?.parse([
          'node',
          'test',
          '--project',
          'test-project',
          '--type',
          'bug',
          '--title',
          'Test bug',
        ]);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('accepts uppercase --type BUG and calls API', async () => {
      const mockTicket = { id: 'ticket-1', number: 1, type: 'BUG', title: 'Test', status: 'created' };
      (TicketsService.create as jest.Mock).mockResolvedValue({ data: { ret: 0, data: mockTicket } });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse(['node', 'test', '--project', 'proj', '--type', 'BUG', '--title', 'Test']);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ type: 'BUG' })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('exits with code 3 and error message when --type is lowercase bug', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse(['node', 'test', '--project', 'proj', '--type', 'bug', '--title', 'Test']);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid type bug. Valid values: BUG, ENHANCEMENT, TASK, QUESTION')
      );
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('accepts uppercase --priority HIGH and calls API', async () => {
      const mockTicket = { id: 'ticket-1', number: 1, type: 'BUG', title: 'Test', status: 'created', priority: 'HIGH' };
      (TicketsService.create as jest.Mock).mockResolvedValue({ data: { ret: 0, data: mockTicket } });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse(['node', 'test', '--project', 'proj', '--type', 'BUG', '--title', 'Test', '--priority', 'HIGH']);

      expect(TicketsService.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ priority: 'HIGH' })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('exits with code 3 and error message when --priority is lowercase high', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const createCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parse(['node', 'test', '--project', 'proj', '--type', 'BUG', '--title', 'Test', '--priority', 'high']);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid priority high. Valid values: LOW, MEDIUM, HIGH, CRITICAL')
      );
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });
  });

  describe('ticket list', () => {
    it('lists tickets for a project', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Bug 1',
          status: 'verified',
          priority: 'high',
          assignee: { slug: 'agent-1', name: 'Agent 1' },
        },
        {
          id: 'ticket-2',
          number: 2,
          type: 'enhancement',
          title: 'Feature 1',
          status: 'created',
          priority: 'medium',
          assignee: null,
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 2 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse(['node', 'test', '--project', 'test-project']);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          projectSlug: 'test-project',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('filters tickets by status', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Verified bug',
          status: 'verified',
          priority: 'high',
          assignee: null,
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--status',
        'verified',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          status: 'verified',
        })
      );
    });

    it('filters tickets by type', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Bug 1',
          status: 'created',
          priority: 'high',
          assignee: null,
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--type',
        'bug',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          type: 'bug',
        })
      );
    });

    it('filters tickets by priority', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Critical bug',
          status: 'created',
          priority: 'critical',
          assignee: null,
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--priority',
        'critical',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          priority: 'critical',
        })
      );
    });

    it('filters tickets by assignee', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Assigned bug',
          status: 'in_progress',
          priority: 'high',
          assignee: { slug: 'agent-1', name: 'Agent 1' },
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--assigned-to',
        'agent-1',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          assignedTo: 'agent-1',
        })
      );
    });

    it('filters unassigned tickets', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Unassigned bug',
          status: 'verified',
          priority: 'high',
          assignee: null,
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--unassigned',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          unassigned: true,
        })
      );
    });

    it('supports pagination with limit', async () => {
      const mockTickets = [];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: mockTickets,
        meta: { total: 0, page: 1, limit: 10 },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--limit',
        '10',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          limit: 10,
        })
      );
    });

    it('supports pagination with page', async () => {
      const mockTickets = [];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 0 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
        '--page',
        '2',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          page: 2,
        })
      );
    });

    it('displays table with correct columns', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Test bug',
          status: 'verified',
          priority: 'high',
          assignee: { slug: 'agent-1', name: 'Agent 1' },
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parse(['node', 'test', '--project', 'test-project']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('#'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Type'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Priority'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Status'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Assignee'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Title'));
    });

    it('returns JSON with --json flag', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'Test bug',
          status: 'verified',
          priority: 'high',
          assignee: null,
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test', '--project', 'test-project', '--json']);
      } catch {
        // Expected
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ticket-1'));
    });
  });

  describe('ticket mine', () => {
    it('lists tickets assigned to current agent', async () => {
      const mockTickets = [
        {
          id: 'ticket-1',
          number: 1,
          type: 'bug',
          title: 'My bug',
          status: 'in_progress',
          priority: 'high',
          assignee: { slug: 'me', name: 'Me' },
        },
      ];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 1 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const mineCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'mine');

      await mineCmd?.parse(['node', 'test']);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          assignedTo: 'self',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('supports optional project filter', async () => {
      const mockTickets = [];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 0 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const mineCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'mine');

      await mineCmd?.parse([
        'node',
        'test',
        '--project',
        'test-project',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          projectSlug: 'test-project',
          assignedTo: 'self',
        })
      );
    });

    it('supports status filter', async () => {
      const mockTickets = [];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 0 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const mineCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'mine');

      await mineCmd?.parse([
        'node',
        'test',
        '--status',
        'verified',
      ]);

      expect(TicketsService.list).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          status: 'verified',
        })
      );
    });

    it('returns JSON with --json flag', async () => {
      const mockTickets = [];

      (TicketsService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: { items: mockTickets, total: 0 } },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const mineCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'mine');

      try {
        await mineCmd?.parse(['node', 'test', '--json']);
      } catch {
        // Expected
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('['));
    });
  });

  describe('ticket show', () => {
    it('displays ticket details by KODA-* reference', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 42,
        projectKey: 'KODA',
        type: 'bug',
        title: 'Test bug',
        description: 'A description',
        status: 'verified',
        priority: 'high',
        assignee: { slug: 'agent-1', name: 'Agent 1' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        comments: [
          {
            id: 'comment-1',
            body: 'A comment',
            type: 'general',
            createdAt: new Date().toISOString(),
            author: { name: 'Author' },
          },
        ],
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

      await showCmd?.parse(['node', 'test', 'KODA-42']);

      expect(TicketsService.show).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-42'
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('displays ticket details by CUID', async () => {
      const mockTicket = {
        id: 'cuid123456',
        number: 1,
        projectKey: 'TEST',
        type: 'enhancement',
        title: 'New feature',
        status: 'created',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

      await showCmd?.parse(['node', 'test', 'cuid123456']);

      expect(TicketsService.show).toHaveBeenCalledWith(
        expect.any(Object),
        'cuid123456'
      );
    });

    it('displays all ticket details including timestamps', async () => {
      const now = new Date().toISOString();
      const mockTicket = {
        id: 'ticket-1',
        number: 42,
        projectKey: 'KODA',
        type: 'bug',
        title: 'Test bug',
        description: 'A description',
        status: 'verified',
        priority: 'high',
        assignee: { slug: 'agent-1', name: 'Agent 1' },
        createdAt: now,
        updatedAt: now,
        comments: [],
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

      await showCmd?.parse(['node', 'test', 'KODA-42']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Title'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Status'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Created'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Updated'));
    });

    it('displays all comments with details', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 42,
        projectKey: 'KODA',
        type: 'bug',
        title: 'Test bug',
        status: 'verified',
        priority: 'high',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        comments: [
          {
            id: 'comment-1',
            body: 'Verification comment',
            type: 'verification',
            createdAt: new Date().toISOString(),
            author: { name: 'Reviewer' },
          },
          {
            id: 'comment-2',
            body: 'Fix report',
            type: 'fix_report',
            createdAt: new Date().toISOString(),
            author: { name: 'Developer' },
          },
        ],
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

      await showCmd?.parse(['node', 'test', 'KODA-42']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Verification comment'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Fix report'));
    });

    it('returns JSON with --json flag', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 42,
        projectKey: 'KODA',
        type: 'bug',
        title: 'Test bug',
        status: 'verified',
        priority: 'high',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'KODA-42', '--json']);
      } catch {
        // Expected
      }

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ticket-1'));
    });

    it('handles not found error', async () => {
      const mockError = new Error('Not found');
      (mockError as any).response = { status: 404 };

      (TicketsService.show as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

      try {
        await showCmd?.parse(['node', 'test', 'KODA-999']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('ticket verify', () => {
    it('transitions ticket from CREATED to VERIFIED with comment', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verified',
        priority: 'high',
        createdAt: new Date().toISOString(),
      };

      (TicketsService.verify as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify');

      await verifyCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Verified this bug',
      ]);

      expect(TicketsService.verify).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          body: 'Verified this bug',
          type: 'VERIFICATION',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('requires comment option', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify');

      try {
        await verifyCmd?.parse(['node', 'test', 'KODA-1']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('enforces VERIFICATION comment type via API', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verified',
        priority: 'high',
      };

      (TicketsService.verify as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify');

      await verifyCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Verified',
      ]);

      expect(TicketsService.verify).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          type: 'VERIFICATION',
        })
      );
    });

    it('displays transition error message on API validation failure', async () => {
      const mockError = new Error('Invalid transition');
      (mockError as any).response = {
        status: 400,
        data: { error: 'Cannot transition from IN_PROGRESS to VERIFIED' },
      };

      (TicketsService.verify as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify');

      try {
        await verifyCmd?.parse([
          'node',
          'test',
          'KODA-1',
          '--comment',
          'Verified',
        ]);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('ticket assign', () => {
    it('assigns ticket to specific agent', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verified',
        priority: 'high',
        assignee: { slug: 'agent-123', name: 'Agent Name' },
      };

      (TicketsService.assign as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const assignCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'assign');

      await assignCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--to',
        'agent-123',
      ]);

      expect(TicketsService.assign).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          agentSlug: 'agent-123',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('self-assigns ticket when --to is omitted', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verified',
        priority: 'high',
        assignee: { slug: 'me', name: 'Me' },
      };

      (TicketsService.assign as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const assignCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'assign');

      await assignCmd?.parse(['node', 'test', 'KODA-1']);

      expect(TicketsService.assign).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          agentSlug: 'self',
        })
      );
    });
  });

  describe('ticket start', () => {
    it('transitions ticket from VERIFIED to IN_PROGRESS', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'in_progress',
        priority: 'high',
      };

      (TicketsService.start as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const startCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'start');

      await startCmd?.parse(['node', 'test', 'KODA-1']);

      expect(TicketsService.start).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1'
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('displays error on invalid transition', async () => {
      const mockError = new Error('Invalid transition');
      (mockError as any).response = {
        status: 400,
        data: { error: 'Cannot transition from CREATED to IN_PROGRESS' },
      };

      (TicketsService.start as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const startCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'start');

      try {
        await startCmd?.parse(['node', 'test', 'KODA-1']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('ticket fix', () => {
    it('transitions ticket from IN_PROGRESS to VERIFY_FIX with comment', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verify_fix',
        priority: 'high',
      };

      (TicketsService.fix as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const fixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'fix');

      await fixCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Fixed the bug',
      ]);

      expect(TicketsService.fix).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          body: 'Fixed the bug',
          type: 'FIX_REPORT',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('includes git reference in fix report', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verify_fix',
        priority: 'high',
      };

      (TicketsService.fix as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const fixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'fix');

      await fixCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Fixed the bug',
        '--git-ref',
        'v1.0:src/auth.ts:42',
      ]);

      expect(TicketsService.fix).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          gitRef: 'v1.0:src/auth.ts:42',
          type: 'FIX_REPORT',
        })
      );
    });

    it('requires comment option', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const fixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'fix');

      try {
        await fixCmd?.parse(['node', 'test', 'KODA-1']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('enforces FIX_REPORT comment type via API', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'verify_fix',
        priority: 'high',
      };

      (TicketsService.fix as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const fixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'fix');

      await fixCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Fixed',
      ]);

      expect(TicketsService.fix).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          type: 'FIX_REPORT',
        })
      );
    });
  });

  describe('ticket verify-fix', () => {
    it('transitions VERIFY_FIX to CLOSED with --pass', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'closed',
        priority: 'high',
      };

      (TicketsService.verifyFix as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');

      await verifyFixCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Looks good',
        '--pass',
      ]);

      expect(TicketsService.verifyFix as jest.Mock).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          body: 'Looks good',
          type: 'REVIEW',
          status: 'closed',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('transitions VERIFY_FIX to IN_PROGRESS with --fail', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'in_progress',
        priority: 'high',
      };

      (TicketsService.verifyFix as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');

      await verifyFixCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Need more work',
        '--fail',
      ]);

      expect(TicketsService.verifyFix as jest.Mock).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          body: 'Need more work',
          type: 'REVIEW',
          status: 'in_progress',
        })
      );
    });

    it('requires comment option', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');

      try {
        await verifyFixCmd?.parse(['node', 'test', 'KODA-1']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('enforces REVIEW comment type via API', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'closed',
        priority: 'high',
      };

      (TicketsService.verifyFix as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const verifyFixCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'verify-fix');

      await verifyFixCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Looks good',
        '--pass',
      ]);

      expect(TicketsService.verifyFix as jest.Mock).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          type: 'REVIEW',
        })
      );
    });
  });

  describe('ticket close', () => {
    it('manually closes a ticket', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'closed',
        priority: 'high',
      };

      (TicketsService.close as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const closeCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'close');

      await closeCmd?.parse(['node', 'test', 'KODA-1']);

      expect(TicketsService.close).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1'
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('displays error on invalid transition', async () => {
      const mockError = new Error('Invalid transition');
      (mockError as any).response = {
        status: 400,
        data: { error: 'Cannot close ticket in CREATED state' },
      };

      (TicketsService.close as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const closeCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'close');

      try {
        await closeCmd?.parse(['node', 'test', 'KODA-1']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('ticket reject', () => {
    it('rejects ticket from any state with comment', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'rejected',
        priority: 'high',
      };

      (TicketsService.reject as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const rejectCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'reject');

      await rejectCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Not reproducible',
      ]);

      expect(TicketsService.reject as jest.Mock).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          body: 'Not reproducible',
          type: 'GENERAL',
        })
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('requires comment option', async () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const rejectCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'reject');

      try {
        await rejectCmd?.parse(['node', 'test', 'KODA-1']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it('enforces GENERAL comment type via API', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 1,
        type: 'bug',
        title: 'Test bug',
        status: 'rejected',
        priority: 'high',
      };

      (TicketsService.reject as jest.Mock).mockResolvedValue({
        data: mockTicket,
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const rejectCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'reject');

      await rejectCmd?.parse([
        'node',
        'test',
        'KODA-1',
        '--comment',
        'Rejected',
      ]);

      expect(TicketsService.reject as jest.Mock).toHaveBeenCalledWith(
        expect.any(Object),
        'KODA-1',
        expect.objectContaining({
          type: 'GENERAL',
        })
      );
    });
  });

  describe('error handling and exit codes', () => {
    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test', '--project', 'test-project']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 1 on API error', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (TicketsService.list as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test', '--project', 'test-project']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on unauthorized error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 401 };

      (TicketsService.list as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const listCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parse(['node', 'test', '--project', 'test-project']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('ticket open', () => {
    it('opens ticket with correct URL', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 42,
        projectId: 'proj-1',
        type: 'bug',
        title: 'Test bug',
        status: 'created',
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const openCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'open');

      try {
        await openCmd?.parse(['node', 'test', 'KODA-42']);
      } catch {
        // Expected
      }

      expect(consoleLogSpy).toHaveBeenCalledWith('✓ Opening ticket in browser');
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('opens ticket with project option', async () => {
      const mockTicket = {
        id: 'ticket-1',
        number: 42,
        projectId: 'proj-1',
        type: 'bug',
        title: 'Test bug',
        status: 'created',
      };

      (TicketsService.show as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockTicket },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const openCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'open');

      try {
        await openCmd?.parse(['node', 'test', 'KODA-42', '--project', 'my-project']);
      } catch {
        // Expected
      }

      expect(consoleLogSpy).toHaveBeenCalledWith('✓ Opening ticket in browser');
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const openCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'open');

      try {
        await openCmd?.parse(['node', 'test', 'KODA-42']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('handles ticket not found error', async () => {
      const mockError = new Error('Not found');
      (mockError as any).response = { status: 404 };

      (TicketsService.show as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const openCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'open');

      try {
        await openCmd?.parse(['node', 'test', 'KODA-999']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('handles authorization error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 403 };

      (TicketsService.show as jest.Mock).mockRejectedValue(mockError);

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const openCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'open');

      try {
        await openCmd?.parse(['node', 'test', 'KODA-42']);
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });
  });
});
