// Mock child_process to prevent real browser opens during tests
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

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
  delete: jest.fn(),
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
    update: jest.fn(),
    delete: jest.fn(),
  },
  TicketLinksService: {
    create: jest.fn(),
    list: jest.fn(),
    delete: jest.fn(),
  },
  LabelsService: {
    addToTicket: jest.fn(),
    removeFromTicket: jest.fn(),
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
import { ticketCommand } from './ticket';
import { TicketsService, TicketLinksService } from '../generated';

const TEST_URL = 'https://github.com/owner/repo/pull/1';
const TEST_REF = 'KDA-42';
const PROJECT_SLUG = 'test-project';

const mockLink = {
  id: 'link-1',
  url: TEST_URL,
  provider: 'github',
  externalRef: 'owner/repo#1',
  createdAt: new Date().toISOString(),
};

describe('ticket link subcommand', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    ticketCommand(program);

    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // record call without throwing
    }) as never);

    jest.clearAllMocks();
    (TicketLinksService.create as jest.Mock).mockReset();
    (TicketLinksService.list as jest.Mock).mockReset();
    (TicketLinksService.delete as jest.Mock).mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('command registration', () => {
    it('registers link subcommand under ticket', () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const subcommands = ticketCmd?.commands.map((cmd) => cmd.name()) ?? [];
      expect(subcommands).toContain('link');
    });

    it('registers unlink subcommand under ticket', () => {
      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const subcommands = ticketCmd?.commands.map((cmd) => cmd.name()) ?? [];
      expect(subcommands).toContain('unlink');
    });
  });

  describe('ticket link <ref> --url <url>', () => {
    it('AC-1: calls POST links endpoint and prints provider and externalRef', async () => {
      (TicketLinksService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockLink },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const linkCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'link');

      await linkCmd?.parseAsync([
        'node', 'test',
        '--project', PROJECT_SLUG,
        TEST_REF,
        '--url', TEST_URL,
      ]);

      expect(TicketLinksService.create).toHaveBeenCalledWith(
        expect.any(Object),
        PROJECT_SLUG,
        TEST_REF,
        { url: TEST_URL }
      );

      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('github');
      expect(output).toContain('owner/repo#1');
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('AC-2: with --json flag prints raw TicketLinkResponseDto JSON', async () => {
      (TicketLinksService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockLink },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const linkCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'link');

      await linkCmd?.parseAsync([
        'node', 'test',
        '--project', PROJECT_SLUG,
        TEST_REF,
        '--url', TEST_URL,
        '--json',
      ]);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      const parsed = JSON.parse(output);
      expect(parsed).toMatchObject({
        id: 'link-1',
        url: TEST_URL,
        provider: 'github',
        externalRef: 'owner/repo#1',
      });
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('AC-3: when URL already linked prints existing link and exits 0', async () => {
      // API returns existing link (same shape as create, but status 200 in real API;
      // for CLI the response shape is the same)
      (TicketLinksService.create as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: mockLink },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const linkCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'link');

      await linkCmd?.parseAsync([
        'node', 'test',
        '--project', PROJECT_SLUG,
        TEST_REF,
        '--url', TEST_URL,
      ]);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('github');
      expect(processExitSpy).toHaveBeenCalledWith(0);
      // Must NOT exit with 1
      expect(processExitSpy).not.toHaveBeenCalledWith(1);
    });
  });

  describe('ticket unlink <ref> --url <url>', () => {
    it('AC-4: when matching link exists calls DELETE and exits 0', async () => {
      const anotherLink = { ...mockLink, id: 'link-2', url: 'https://github.com/other/repo/pull/9' };
      (TicketLinksService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: [anotherLink, mockLink] },
      });
      (TicketLinksService.delete as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: null },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const unlinkCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'unlink');

      await unlinkCmd?.parseAsync([
        'node', 'test',
        '--project', PROJECT_SLUG,
        TEST_REF,
        '--url', TEST_URL,
      ]);

      expect(TicketLinksService.list).toHaveBeenCalledWith(
        expect.any(Object),
        PROJECT_SLUG,
        TEST_REF
      );
      expect(TicketLinksService.delete).toHaveBeenCalledWith(
        expect.any(Object),
        PROJECT_SLUG,
        TEST_REF,
        'link-1'
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('AC-5: when no matching link prints message and exits 1', async () => {
      const otherLink = { ...mockLink, id: 'link-99', url: 'https://github.com/other/repo/pull/99' };
      (TicketLinksService.list as jest.Mock).mockResolvedValue({
        data: { ret: 0, data: [otherLink] },
      });

      const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
      const unlinkCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'unlink');

      await unlinkCmd?.parseAsync([
        'node', 'test',
        '--project', PROJECT_SLUG,
        TEST_REF,
        '--url', TEST_URL,
      ]);

      expect(TicketLinksService.delete).not.toHaveBeenCalled();

      const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain(`No link found for ${TEST_URL}`);
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});

describe('ticket show --json includes links array (AC-6)', () => {
  let program: Command;
  let consoleLogSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    ticketCommand(program);

    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';

    delete process.env.KODA_API_KEY;
    delete process.env.KODA_API_URL;

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    jest.clearAllMocks();
    (TicketsService.show as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('JSON output contains links array with provider and url fields', async () => {
    const mockTicketWithLinks = {
      id: 'ticket-1',
      number: 42,
      ref: 'KDA-42',
      type: 'BUG',
      title: 'Test ticket',
      status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(),
      links: [
        {
          id: 'link-1',
          url: TEST_URL,
          provider: 'github',
          externalRef: 'owner/repo#1',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    (TicketsService.show as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: mockTicketWithLinks },
    });

    const ticketCmd = program.commands.find((cmd) => cmd.name() === 'ticket');
    const showCmd = ticketCmd?.commands.find((cmd) => cmd.name() === 'show');

    await showCmd?.parseAsync([
      'node', 'test',
      '--project', 'test-project',
      '--json',
      'KDA-42',
    ]);

    const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty('links');
    expect(Array.isArray(parsed.links)).toBe(true);
    expect(parsed.links.length).toBeGreaterThanOrEqual(1);
    expect(parsed.links[0]).toMatchObject({
      provider: 'github',
      url: TEST_URL,
    });
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });
});
