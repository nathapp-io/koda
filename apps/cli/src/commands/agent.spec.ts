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
  agentsControllerFindMe: jest.fn(),
  agentsControllerSuggestTicket: jest.fn(),
  agentsControllerFindAll: jest.fn(),
  agentsControllerGenerateApiKey: jest.fn(),
  agentsControllerUpdate: jest.fn(),
  agentsControllerRemove: jest.fn(),
  agentsControllerRotateApiKey: jest.fn(),
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
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  maskApiKey: jest.fn((key: string) => {
    if (!key || key.length < 4) return '****';
    if (key.startsWith('sk-proj-')) {
      const rest = key.slice('sk-proj-'.length);
      return `sk-proj-${'*'.repeat(Math.max(4, rest.length))}`;
    }
    const visible = key.slice(-6);
    return `***${visible}`;
  }),
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { agentCommand } from './agent';
import {
  agentsControllerFindMe,
  agentsControllerSuggestTicket,
  agentsControllerFindAll,
  agentsControllerGenerateApiKey,
  agentsControllerUpdate,
  agentsControllerRemove,
  agentsControllerRotateApiKey,
} from '../generated';
import { resolveContext } from '../config';

describe('agentCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    agentCommand(program);

    // Setup default config
    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Don't throw, just record the call
    }) as any);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.clearAllMocks();

    // Default resolveContext mock for all tests (after clearAllMocks)
    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100/api',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('agent me', () => {
    it('fetches and displays current agent profile', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: 'sk-test-key123',
      };

      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      await meCmd?.parseAsync(['node', 'test']);

      expect(agentsControllerFindMe).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('masks API key in human output', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: 'sk-1234567890abcdef',
      };

      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      await meCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalled();
      // Check that the full API key was NOT logged (it should be masked)
      const allLogs = logSpy.mock.calls.map((call) => call[0]).join(' ');
      expect(allLogs).not.toContain('sk-1234567890abcdef');
    });

    it('returns JSON with --json flag', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: 'sk-test-key123',
      };

      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parseAsync(['node', 'test', '--json']);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-agent')
      );
    });

    it('exits with code 2 when API key is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: '',
        apiUrl: '',
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (agentsControllerFindMe as jest.Mock).mockRejectedValue(mockError);

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on unauthorized error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 401 };

      (agentsControllerFindMe as jest.Mock).mockRejectedValue(mockError);

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('JSON output contains all agent fields', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: 'sk-test-key123',
      };

      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parseAsync(['node', 'test', '--json']);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"id"')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"name"')
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"slug"')
      );
    });

    it('displays hash message when apiKey is undefined', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: undefined,
      };

      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      await meCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('(stored as hash — not recoverable)')
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('masks API key when apiKey is defined', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: 'abcd1234efgh5678',
      };

      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      await meCmd?.parseAsync(['node', 'test']);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('****5678')
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('agent pickup', () => {
    const mockAgent = {
      id: 'agent-1',
      name: 'Test Agent',
      slug: 'test-agent',
      apiKey: 'sk-test-key123',
    };

    const mockPickupResult = {
      ticket: {
        id: 'ticket-1',
        number: 42,
        title: 'Fix the login bug',
        status: 'VERIFIED',
        priority: 'HIGH',
      },
      matchScore: 2,
      matchedCapabilities: ['nestjs', 'prisma'],
    };

    beforeEach(() => {
      mockData.apiKey = 'sk-test-key123';
      mockData.apiUrl = 'http://localhost:3100/api';
      (agentsControllerFindMe as jest.Mock).mockResolvedValue({ ret: 0, data: mockAgent });
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'koda',
        apiKey: 'sk-test-key123',
        apiUrl: 'http://localhost:3100/api',
      });
    });

    it('prints formatted output when a matching ticket is found', async () => {
      (agentsControllerSuggestTicket as jest.Mock).mockResolvedValue({ ret: 0, data: mockPickupResult });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      await pickupCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(agentsControllerFindMe).toHaveBeenCalled();
      expect(agentsControllerSuggestTicket).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Suggested ticket: #42 — Fix the login bug');
      expect(logSpy).toHaveBeenCalledWith('Priority: HIGH | Status: VERIFIED');
      expect(logSpy).toHaveBeenCalledWith('Match score: 2 | Matched capabilities: nestjs, prisma');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints no-tickets message when result is null', async () => {
      (agentsControllerSuggestTicket as jest.Mock).mockResolvedValue({ ret: 0, data: null });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      await pickupCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(logSpy).toHaveBeenCalledWith('No suitable tickets found for pickup.');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits with code 2 when projectSlug is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: undefined,
        apiKey: 'sk-test-key123',
        apiUrl: 'http://localhost:3100/api',
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      try {
        await pickupCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 2 when auth is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'koda',
        apiKey: '',
        apiUrl: '',
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      try {
        await pickupCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('outputs JSON with --json flag', async () => {
      (agentsControllerSuggestTicket as jest.Mock).mockResolvedValue({ ret: 0, data: mockPickupResult });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      try {
        await pickupCmd?.parseAsync(['node', 'test', '--project', 'koda', '--json']);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"matchScore"')
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('agent list', () => {
    it('lists agents in a table', async () => {
      (agentsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: [{ name: 'Agent One', slug: 'agent-one', status: 'ACTIVE', maxConcurrentTickets: 3 }],
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const listCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test']);

      expect(agentsControllerFindAll).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON with --json flag', async () => {
      (agentsControllerFindAll as jest.Mock).mockResolvedValue({ ret: 0, data: [] });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const listCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--json']);

      expect(logSpy).toHaveBeenCalledWith('[]');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('agent create', () => {
    it('creates an agent and prints the generated API key', async () => {
      (agentsControllerGenerateApiKey as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { name: 'New Agent', slug: 'new-agent', apiKey: 'sk-generated-key' },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const createCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync(['node', 'test', '--name', 'New Agent', '--roles', 'DEVELOPER,AGENT']);

      expect(agentsControllerGenerateApiKey).toHaveBeenCalledWith({
        requestBody: expect.objectContaining({
          name: 'New Agent',
          roles: ['DEVELOPER', 'AGENT'],
        }),
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sk-generated-key'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('defaults roles to an empty array when --roles is omitted', async () => {
      (agentsControllerGenerateApiKey as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { name: 'New Agent', slug: 'new-agent' },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const createCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'create');

      await createCmd?.parseAsync(['node', 'test', '--name', 'New Agent']);

      expect(agentsControllerGenerateApiKey).toHaveBeenCalledWith({
        requestBody: expect.objectContaining({ roles: [] }),
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('agent update', () => {
    it('updates an agent by slug', async () => {
      (agentsControllerUpdate as jest.Mock).mockResolvedValue({ ret: 0, data: { name: 'Renamed' } });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const updateCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'update');

      await updateCmd?.parseAsync(['node', 'test', 'agent-one', '--status', 'PAUSED']);

      expect(agentsControllerUpdate).toHaveBeenCalledWith({
        slug: 'agent-one',
        requestBody: expect.objectContaining({ status: 'PAUSED' }),
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('agent rotate-key', () => {
    it('rotates the API key and prints the new key', async () => {
      (agentsControllerRotateApiKey as jest.Mock).mockResolvedValue({ ret: 0, data: { apiKey: 'sk-rotated' } });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const rotateCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'rotate-key');

      await rotateCmd?.parseAsync(['node', 'test', 'agent-one']);

      expect(agentsControllerRotateApiKey).toHaveBeenCalledWith({ slug: 'agent-one' });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sk-rotated'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('agent delete', () => {
    it('deletes an agent by slug', async () => {
      (agentsControllerRemove as jest.Mock).mockResolvedValue({ ret: 0, data: undefined });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const deleteCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync(['node', 'test', 'agent-one']);

      expect(agentsControllerRemove).toHaveBeenCalledWith({ slug: 'agent-one' });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('surfaces a not-found error for a missing agent', async () => {
      const notFoundErr: any = new Error('Not found');
      notFoundErr.response = { status: 404 };
      (agentsControllerRemove as jest.Mock).mockRejectedValue(notFoundErr);

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const deleteCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'delete');

      try {
        await deleteCmd?.parseAsync(['node', 'test', 'missing-agent']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalled();
    });
  });
});
