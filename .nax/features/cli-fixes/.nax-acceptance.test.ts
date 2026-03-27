// Acceptance tests for cli-fixes feature
// Verifies: ref rendering in ticket list/mine, and apiKey=undefined safety in agent me

// Mock chalk early to prevent ESM issues
jest.mock('chalk', () => ({
  cyan: { bold: (str: string) => str },
  gray: (str: string) => str,
  green: (str: string) => str,
  red: (str: string) => str,
  yellow: (str: string) => str,
}));

// Mock conf before importing
const mockData: Record<string, string> = {};
const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => { mockData[key] = value; }),
};
jest.mock('conf', () => jest.fn(() => mockStore));

// Mock axios client
jest.mock('axios', () => ({ create: () => ({ get: jest.fn(), post: jest.fn(), patch: jest.fn() }) }));

// Mock generated client
jest.mock('../../../apps/cli/src/generated', () => ({
  TicketsService: {
    list: jest.fn(),
    create: jest.fn(),
    show: jest.fn(),
    verify: jest.fn(),
    assign: jest.fn(),
    start: jest.fn(),
    fix: jest.fn(),
    verifyFix: jest.fn(),
    close: jest.fn(),
    reject: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  LabelsService: {
    addToTicket: jest.fn(),
    removeFromTicket: jest.fn(),
  },
  TicketLinksService: {
    create: jest.fn(),
    list: jest.fn(),
    delete: jest.fn(),
  },
  AgentService: {
    me: jest.fn(),
    pickup: jest.fn(),
  },
}));

// Mock config module
jest.mock('../../../apps/cli/src/config', () => ({
  getConfig: jest.fn(() => ({ apiKey: 'sk-test-key', apiUrl: 'http://localhost:3100/api' })),
  setConfig: jest.fn(),
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { ticketCommand } from '../../../apps/cli/src/commands/ticket';
import { agentCommand } from '../../../apps/cli/src/commands/agent';
import { TicketsService, AgentService } from '../../../apps/cli/src/generated';
import { resolveContext } from '../../../apps/cli/src/config';

const DEFAULT_CTX = {
  projectSlug: 'test-project',
  apiKey: 'sk-test-key',
  apiUrl: 'http://localhost:3100/api',
};

function makeProgram(): Command {
  const p = new Command();
  p.exitOverride();
  return p;
}

function getSubCommand(program: Command, ...path: string[]): Command {
  let cmd: Command = program;
  for (const name of path) {
    const found = cmd.commands.find((c) => c.name() === name);
    if (!found) throw new Error(`Sub-command '${name}' not found`);
    cmd = found;
  }
  return cmd;
}

describe('cli-fixes acceptance tests', () => {
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (resolveContext as jest.Mock).mockResolvedValue(DEFAULT_CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC-1: When TicketsService.list() returns a ticket with ref=\'NAX-1\', the ticket list table renders the first column as \'NAX-1\'', async () => {
    const program = makeProgram();
    ticketCommand(program);

    (TicketsService.list as jest.Mock).mockResolvedValue({
      data: {
        ret: 0,
        data: {
          items: [{ ref: 'NAX-1', number: 1, type: 'BUG', priority: 'HIGH', status: 'VERIFIED', title: 'Test bug', assignee: null }],
        },
      },
    });

    const listCmd = getSubCommand(program, 'ticket', 'list');
    await listCmd.parseAsync(['node', 'test', '--project', 'test-project']);

    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('NAX-1');
    expect(allLogs).not.toMatch(/KODA-1\b/);
  });

  it('AC-2: When TicketsService.list() returns a ticket with ref=\'NAX-2\', the ticket mine table renders the first column as \'NAX-2\'', async () => {
    const program = makeProgram();
    ticketCommand(program);

    (TicketsService.list as jest.Mock).mockResolvedValue({
      data: {
        ret: 0,
        data: {
          items: [{ ref: 'NAX-2', number: 2, type: 'ENHANCEMENT', priority: 'MEDIUM', status: 'IN_PROGRESS', title: 'My ticket', assignee: null }],
        },
      },
    });

    const mineCmd = getSubCommand(program, 'ticket', 'mine');
    await mineCmd.parseAsync(['node', 'test', '--project', 'test-project']);

    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('NAX-2');
    expect(allLogs).not.toMatch(/KODA-2\b/);
  });

  it('AC-3: When a ticket object has ref=undefined, the ticket list table renders the first column as \'KODA-1\' (fallback)', async () => {
    const program = makeProgram();
    ticketCommand(program);

    (TicketsService.list as jest.Mock).mockResolvedValue({
      data: {
        ret: 0,
        data: {
          items: [{ ref: undefined, number: 1, type: 'BUG', priority: 'LOW', status: 'CREATED', title: 'No ref ticket', assignee: null }],
        },
      },
    });

    const listCmd = getSubCommand(program, 'ticket', 'list');
    await listCmd.parseAsync(['node', 'test', '--project', 'test-project']);

    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('KODA-1');
  });

  it('AC-4: When a ticket object has ref=undefined, the ticket mine table renders the first column as \'KODA-2\' (fallback)', async () => {
    const program = makeProgram();
    ticketCommand(program);

    (TicketsService.list as jest.Mock).mockResolvedValue({
      data: {
        ret: 0,
        data: {
          items: [{ ref: undefined, number: 2, type: 'TASK', priority: 'MEDIUM', status: 'IN_PROGRESS', title: 'Mine no ref', assignee: null }],
        },
      },
    });

    const mineCmd = getSubCommand(program, 'ticket', 'mine');
    await mineCmd.parseAsync(['node', 'test', '--project', 'test-project']);

    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('KODA-2');
  });

  it('AC-5: When AgentService.me() returns an agent where apiKey is undefined, koda agent me exits with code 0 and does not throw', async () => {
    const program = makeProgram();
    agentCommand(program);

    (AgentService.me as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: { id: 'a1', name: 'Bot', slug: 'bot', apiKey: undefined } },
    });

    const meCmd = getSubCommand(program, 'agent', 'me');
    await expect(meCmd.parseAsync(['node', 'test'])).resolves.not.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('AC-6: When agentData.apiKey is undefined, the output includes \'API Key: (stored as hash — not recoverable)\'', async () => {
    const program = makeProgram();
    agentCommand(program);

    (AgentService.me as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: { id: 'a1', name: 'Bot', slug: 'bot', apiKey: undefined } },
    });

    const meCmd = getSubCommand(program, 'agent', 'me');
    await meCmd.parseAsync(['node', 'test']);

    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('API Key: (stored as hash — not recoverable)');
  });

  it('AC-7: When agentData.apiKey is \'abcd1234efgh5678\', the output includes \'API Key: abcd****5678\'', async () => {
    const program = makeProgram();
    agentCommand(program);

    (AgentService.me as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: { id: 'a1', name: 'Bot', slug: 'bot', apiKey: 'abcd1234efgh5678' } },
    });

    const meCmd = getSubCommand(program, 'agent', 'me');
    await meCmd.parseAsync(['node', 'test']);

    const allLogs = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allLogs).toContain('API Key: abcd****5678');
  });
});
