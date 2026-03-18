import { Command } from 'commander';
import { agentCommand } from './agent';
import * as configModule from '../config';
import * as clientModule from '../client';
import { AgentsService } from '../generated';

jest.mock('../config');
jest.mock('../client');
jest.mock('../generated', () => ({
  AgentsService: {
    me: jest.fn(),
  },
}));

describe('agent command', () => {
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

  describe('agent me', () => {
    it('registers agent me subcommand', () => {
      agentCommand(program);

      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent');
      const meCmd = agentCmd?.commands.find((cmd) => cmd.name() === 'me');
      expect(meCmd).toBeDefined();
    });

    it('displays current agent name', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: {
          id: 'agent-123',
          name: 'AI Agent 1',
          slug: 'ai-agent-1',
          status: 'ACTIVE',
          roles: ['DEVELOPER', 'REVIEWER'],
          maxConcurrentTickets: 5,
        },
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('AI Agent 1'));
    });

    it('displays agent slug', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: {
          id: 'agent-123',
          name: 'AI Agent 1',
          slug: 'ai-agent-1',
          status: 'ACTIVE',
          roles: ['DEVELOPER', 'REVIEWER'],
          maxConcurrentTickets: 5,
        },
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ai-agent-1'));
    });

    it('displays agent roles', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: {
          id: 'agent-123',
          name: 'AI Agent 1',
          slug: 'ai-agent-1',
          status: 'ACTIVE',
          roles: ['DEVELOPER', 'REVIEWER'],
          maxConcurrentTickets: 5,
        },
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('DEVELOPER'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('REVIEWER'));
    });

    it('displays agent status', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: {
          id: 'agent-123',
          name: 'AI Agent 1',
          slug: 'ai-agent-1',
          status: 'ACTIVE',
          roles: ['DEVELOPER', 'REVIEWER'],
          maxConcurrentTickets: 5,
        },
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ACTIVE'));
    });

    it('displays agent info in human-readable format', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: {
          id: 'agent-456',
          name: 'Code Master',
          slug: 'code-master',
          status: 'ACTIVE',
          roles: ['DEVELOPER'],
          maxConcurrentTickets: 3,
        },
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Code Master') ||
          expect.stringContaining('code-master') ||
          expect.stringContaining('ACTIVE') ||
          expect.stringContaining('DEVELOPER')
      );
    });

    it('outputs valid JSON when --json flag is provided', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockAgent = {
        id: 'agent-123',
        name: 'AI Agent 1',
        slug: 'ai-agent-1',
        status: 'ACTIVE',
        roles: ['DEVELOPER', 'REVIEWER'],
        maxConcurrentTickets: 5,
      };
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: mockAgent,
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me', '--json']);

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toHaveProperty('name');
      expect(parsed).toHaveProperty('slug');
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('roles');
    });

    it('JSON output contains agent name', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockAgent = {
        id: 'agent-123',
        name: 'Test Agent',
        slug: 'test-agent',
        status: 'ACTIVE',
        roles: ['DEVELOPER'],
        maxConcurrentTickets: 3,
      };
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: mockAgent,
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me', '--json']);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.name).toBe('Test Agent');
    });

    it('JSON output contains agent slug', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockAgent = {
        id: 'agent-123',
        name: 'Test Agent',
        slug: 'test-agent',
        status: 'PAUSED',
        roles: ['REVIEWER'],
        maxConcurrentTickets: 2,
      };
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: mockAgent,
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me', '--json']);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.slug).toBe('test-agent');
    });

    it('JSON output contains agent status', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockAgent = {
        id: 'agent-123',
        name: 'Test Agent',
        slug: 'test-agent',
        status: 'OFFLINE',
        roles: ['TRIAGER'],
        maxConcurrentTickets: 1,
      };
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: mockAgent,
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me', '--json']);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('OFFLINE');
    });

    it('JSON output contains agent roles array', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      const mockAgent = {
        id: 'agent-123',
        name: 'Test Agent',
        slug: 'test-agent',
        status: 'ACTIVE',
        roles: ['DEVELOPER', 'REVIEWER', 'TRIAGER'],
        maxConcurrentTickets: 5,
      };
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: mockAgent,
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me', '--json']);

      const output = consoleLogSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed.roles)).toBe(true);
      expect(parsed.roles).toContain('DEVELOPER');
      expect(parsed.roles).toContain('REVIEWER');
      expect(parsed.roles).toContain('TRIAGER');
    });

    it('calls AgentsService.me with configured client', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockResolvedValue({
        data: {
          id: 'agent-123',
          name: 'Test Agent',
          slug: 'test-agent',
          status: 'ACTIVE',
          roles: ['DEVELOPER'],
          maxConcurrentTickets: 3,
        },
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(clientModule.configureClient).toHaveBeenCalledWith(
        'http://localhost:3100/api',
        'test-key'
      );
      expect(AgentsService.me).toHaveBeenCalled();
    });

    it('exits with code 2 if no API key configured', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiUrl: 'http://localhost:3100/api',
      });

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 1 on API error', async () => {
      (configModule.getConfig as jest.Mock).mockReturnValue({
        apiKey: 'test-key',
        apiUrl: 'http://localhost:3100/api',
      });
      (clientModule.configureClient as jest.Mock).mockReturnValue({});
      (AgentsService.me as jest.Mock).mockRejectedValue(new Error('API error'));

      agentCommand(program);
      const agentCmd = program.commands.find((cmd) => cmd.name() === 'agent')!;
      const meCmd = agentCmd.commands.find((cmd) => cmd.name() === 'me')!;
      await meCmd.parseAsync(['node', 'koda', 'agent', 'me']);

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
