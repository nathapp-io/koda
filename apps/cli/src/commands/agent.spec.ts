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
};

jest.mock('axios', () => {
  return {
    create: () => mockAxios,
  };
});

// Mock the generated client
jest.mock('../generated', () => ({
  AgentService: {
    me: jest.fn(),
    pickup: jest.fn(),
  },
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
    if (key.length <= 8) return '****';
    return key.substring(0, 4) + '*'.repeat(key.length - 8) + key.substring(key.length - 4);
  }),
}));

import { Command } from 'commander';
import { agentCommand } from './agent';
import { AgentService } from '../generated';

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
    (AgentService.me as jest.Mock).mockReset();
    (AgentService.pickup as jest.Mock).mockReset();
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

      (AgentService.me as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockAgent },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      await meCmd?.parse(['node', 'test']);

      expect(AgentService.me).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('masks API key in human output', async () => {
      const mockAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        apiKey: 'sk-1234567890abcdef',
      };

      (AgentService.me as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockAgent },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      await meCmd?.parse(['node', 'test']);

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

      (AgentService.me as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockAgent },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parse(['node', 'test', '--json']);
      } catch {
        // Expected
      }

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-agent')
      );
    });

    it('exits with code 2 when API key is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors gracefully', async () => {
      const mockError = new Error('API Error');
      (mockError as any).response = { status: 500 };

      (AgentService.me as jest.Mock).mockRejectedValue(mockError);

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parse(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on unauthorized error', async () => {
      const mockError = new Error('Unauthorized');
      (mockError as any).response = { status: 401 };

      (AgentService.me as jest.Mock).mockRejectedValue(mockError);

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parse(['node', 'test']);
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

      (AgentService.me as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockAgent },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');

      try {
        await meCmd?.parse(['node', 'test', '--json']);
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
      (AgentService.me as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockAgent },
      });
    });

    it('prints formatted output when a matching ticket is found', async () => {
      (AgentService.pickup as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockPickupResult },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      await pickupCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(AgentService.me).toHaveBeenCalled();
      expect(AgentService.pickup).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Suggested ticket: #42 — Fix the login bug');
      expect(logSpy).toHaveBeenCalledWith('Priority: HIGH | Status: VERIFIED');
      expect(logSpy).toHaveBeenCalledWith('Match score: 2 | Matched capabilities: nestjs, prisma');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints no-tickets message when result is null', async () => {
      (AgentService.pickup as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: null },
      });

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      await pickupCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(logSpy).toHaveBeenCalledWith('No suitable tickets found for pickup.');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits with code 3 when --project flag is missing', async () => {
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      try {
        await pickupCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('exits with code 2 when auth is not configured', async () => {
      mockData.apiKey = '';
      mockData.apiUrl = '';

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const pickupCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'pickup');

      try {
        await pickupCmd?.parseAsync(['node', 'test', '--project', 'koda']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('outputs JSON with --json flag', async () => {
      (AgentService.pickup as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockPickupResult },
      });

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
});
