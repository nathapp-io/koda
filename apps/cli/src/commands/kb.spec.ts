// Mock chalk early to prevent ESM issues
jest.mock('chalk', () => {
  const mockChalk = {
    cyan: { bold: (str: string) => str },
    gray: (str: string) => str,
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
    bold: (str: string) => str,
    white: (str: string) => str,
    blue: (str: string) => str,
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
  KbService: {
    search: jest.fn(),
    list: jest.fn(),
    add: jest.fn(),
  },
}));

// Mock config module to use mockData instead of real filesystem
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: mockData.apiKey || '',
    apiUrl: mockData.apiUrl || '',
    projectSlug: mockData.projectSlug || '',
  })),
  setConfig: jest.fn(),
  validateApiKey: jest.fn((key: string) => key && key.length >= 10),
  resolveContext: jest.fn(),
}));

// Mock fs module for file reading
const mockFileContent = 'mock file content for testing';
jest.mock('fs/promises', () => ({
  readFile: jest.fn(() => Promise.resolve(mockFileContent)),
}));
jest.mock('fs', () => ({
  readFileSync: jest.fn(() => mockFileContent),
  existsSync: jest.fn(() => true),
}));

import { Command } from 'commander';
import { kbCommand } from './kb';
import { KbService } from '../generated';
import { resolveContext } from '../config';

describe('kbCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    // Prevent Commander from throwing on unrecognized options during sub-command parsing
    program.exitOverride();
    kbCommand(program);

    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100/api';
    mockData.projectSlug = 'koda';

    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100/api',
      projectSlug: 'koda',
    });

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Do not throw, just record the call
    }) as any);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // kb search
  // ---------------------------------------------------------------------------
  describe('kb search', () => {
    const mockSearchResponse = {
      data: {
        ret: 0,
        data: {
          verdict: 'RELEVANT' as const,
          confidence: 0.92,
          results: [
            {
              score: 0.95,
              ticketRef: 'KODA-42',
              type: 'bug' as const,
              status: 'in_progress',
              labels: ['auth', 'critical'],
            },
            {
              score: 0.61,
              ticketRef: 'KODA-17',
              type: 'enhancement' as const,
              status: 'verified',
              labels: [],
            },
          ],
        },
      },
    };

    it('exits 0 and prints verdict + ranked results for a valid search', async () => {
      (KbService.search as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      expect(KbService.search).toHaveBeenCalledWith(
        expect.anything(),
        'koda',
        'auth error'
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints the verdict line in human output', async () => {
      (KbService.search as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toMatch(/RELEVANT/);
    });

    it('prints ranked results with ticket refs in human output', async () => {
      (KbService.search as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('KODA-42');
      expect(allLogs).toContain('KODA-17');
    });

    it('prints score labels (HIGH/MED/LOW) based on score value', async () => {
      (KbService.search as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      // score 0.95 should be HIGH, score 0.61 should be MED
      expect(allLogs).toMatch(/HIGH/);
      expect(allLogs).toMatch(/MED/);
    });

    it('prints confidence score in human output', async () => {
      (KbService.search as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('0.92');
    });

    it('outputs raw JSON matching API response shape with --json flag', async () => {
      (KbService.search as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error', '--json']);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();

      if (!jsonCall) throw new Error('Expected jsonCall to be defined');
      const parsed = JSON.parse(jsonCall[0]);
      expect(parsed).toHaveProperty('verdict');
      expect(parsed).toHaveProperty('confidence');
      expect(parsed).toHaveProperty('results');
      expect(Array.isArray(parsed.results)).toBe(true);
    });

    it('exits with code 2 when project is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: 'sk-test-key123',
        apiUrl: 'http://localhost:3100/api',
        projectSlug: undefined,
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      try {
        await searchCmd?.parseAsync(['node', 'test', '--query', 'auth error']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 3 when --query is missing', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      try {
        await searchCmd?.parseAsync(['node', 'test', '--project', 'koda']);
      } catch {
        // Commander may throw for missing required option
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('exits with code 2 when API key is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100/api',
        projectSlug: 'koda',
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      try {
        await searchCmd?.parseAsync(['node', 'test', '--query', 'auth error']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors via handleApiError', async () => {
      const apiError = new Error('Internal Server Error');
      (apiError as any).response = { status: 500, data: { message: 'Internal Server Error' } };
      (KbService.search as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      try {
        await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 2 on 401 API error', async () => {
      const apiError = new Error('Unauthorized');
      (apiError as any).response = { status: 401 };
      (KbService.search as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      try {
        await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  // ---------------------------------------------------------------------------
  // kb list
  // ---------------------------------------------------------------------------
  describe('kb list', () => {
    const mockListResponse = {
      data: {
        ret: 0,
        data: {
          items: [
            { id: 'doc-1', source: 'README.md', createdAt: '2026-01-10T12:00:00.000Z' },
            { id: 'doc-2', source: 'CONTRIBUTING.md', createdAt: '2026-02-15T09:30:00.000Z' },
          ],
          total: 2,
        },
      },
    };

    it('exits 0 and prints document table', async () => {
      (KbService.list as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(KbService.list).toHaveBeenCalledWith(expect.anything(), 'koda');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('renders table with ID column', async () => {
      (KbService.list as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('doc-1');
      expect(allLogs).toContain('doc-2');
    });

    it('renders table with Source column', async () => {
      (KbService.list as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('README.md');
      expect(allLogs).toContain('CONTRIBUTING.md');
    });

    it('renders table with Created column', async () => {
      (KbService.list as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      // Should contain some recognizable date portion
      expect(allLogs).toMatch(/2026/);
    });

    it('outputs JSON with --json flag', async () => {
      (KbService.list as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda', '--json']);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();

      if (!jsonCall) throw new Error('Expected jsonCall to be defined');
      const parsed = JSON.parse(jsonCall[0]);
      expect(parsed).toHaveProperty('items');
      expect(Array.isArray(parsed.items)).toBe(true);
    });

    it('exits with code 2 when project is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: 'sk-test-key123',
        apiUrl: 'http://localhost:3100/api',
        projectSlug: undefined,
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 2 when auth is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100/api',
        projectSlug: 'koda',
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors via handleApiError', async () => {
      const apiError = new Error('Service unavailable');
      (apiError as any).response = { status: 503, data: { message: 'Service unavailable' } };
      (KbService.list as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      try {
        await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---------------------------------------------------------------------------
  // kb add
  // ---------------------------------------------------------------------------
  describe('kb add', () => {
    const mockAddResponse = {
      data: {
        ret: 0,
        data: {
          id: 'doc-99',
          source: 'README.md',
          docCount: 3,
        },
      },
    };

    it('exits 0 and prints success confirmation with file name', async () => {
      (KbService.add as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      expect(KbService.add).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints confirmation message containing the file name', async () => {
      (KbService.add as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('README.md');
    });

    it('prints confirmation message containing the doc count', async () => {
      (KbService.add as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('3');
    });

    it('reads the file from disk and sends content, source, and sourceId to the API', async () => {
      (KbService.add as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      expect(KbService.add).toHaveBeenCalledWith(
        expect.anything(),
        'koda',
        expect.objectContaining({ content: mockFileContent, source: 'doc', sourceId: 'README.md' })
      );
    });

    it('accepts --source option to override default source type', async () => {
      (KbService.add as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md', '--source', 'manual']);

      expect(KbService.add).toHaveBeenCalledWith(
        expect.anything(),
        'koda',
        expect.objectContaining({ source: 'manual', sourceId: 'README.md' })
      );
    });

    it('exits with code 3 for invalid --source value', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md', '--source', 'invalid']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('outputs JSON with --json flag', async () => {
      (KbService.add as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md', '--json']);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();

      if (!jsonCall) throw new Error('Expected jsonCall to be defined');
      const parsed = JSON.parse(jsonCall[0]);
      expect(parsed).toHaveProperty('id');
      expect(parsed).toHaveProperty('source');
      expect(parsed).toHaveProperty('docCount');
    });

    it('exits with code 2 when project is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: 'sk-test-key123',
        apiUrl: 'http://localhost:3100/api',
        projectSlug: undefined,
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', '--file', './README.md']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 3 when --file is missing', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test']);
      } catch {
        // Commander may throw for missing required option
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('exits with code 2 when auth is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100/api',
        projectSlug: 'koda',
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', '--file', './README.md']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('handles API errors via handleApiError', async () => {
      const apiError = new Error('Bad Request');
      (apiError as any).response = { status: 400, data: { message: 'Invalid document content' } };
      (KbService.add as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', '--file', './README.md']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Command registration
  // ---------------------------------------------------------------------------
  describe('command registration', () => {
    it('registers a kb command on the program', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      expect(kbCmd).toBeDefined();
    });

    it('registers kb search sub-command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');
      expect(searchCmd).toBeDefined();
    });

    it('registers kb list sub-command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');
      expect(listCmd).toBeDefined();
    });

    it('registers kb add sub-command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');
      expect(addCmd).toBeDefined();
    });
  });
});
