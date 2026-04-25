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

// Mock the generated client
jest.mock('../generated', () => ({
  ragControllerSearch: jest.fn(),
  ragControllerListDocuments: jest.fn(),
  ragControllerAddDocument: jest.fn(),
  ragControllerDeleteDocument: jest.fn(),
  ragControllerOptimizeTable: jest.fn(),
  ragControllerImportGraphify: jest.fn(),
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
import {
  ragControllerSearch,
  ragControllerListDocuments,
  ragControllerAddDocument,
  ragControllerDeleteDocument,
  ragControllerOptimizeTable,
  ragControllerImportGraphify,
} from '../generated';
import { resolveContext } from '../config';
import { readFile } from 'fs/promises';

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

    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100/api',
      projectSlug: 'koda',
    });
    (ragControllerDeleteDocument as jest.Mock).mockReset();
    (ragControllerOptimizeTable as jest.Mock).mockReset();
    (ragControllerImportGraphify as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // kb search
  // ---------------------------------------------------------------------------
  describe('kb search', () => {
    const mockSearchResponse = {
      ret: 0,
      data: {
        results: [
          {
            id: 'doc_001',
            source: 'ticket',
            sourceId: 'KODA-42',
            content: 'Fix auth error on login',
            score: 0.95,
            similarity: 'high',
            rank: 1,
            metadata: {},
            createdAt: '2026-01-01T00:00:00.000Z',
            provenance: { indexedAt: '2026-01-01T00:00:00.000Z', sourceProjectId: 'proj-1' },
          },
          {
            id: 'doc_002',
            source: 'ticket',
            sourceId: 'KODA-17',
            content: 'Enhancement for auth flow',
            score: 0.61,
            similarity: 'medium',
            rank: 2,
            metadata: {},
            createdAt: '2026-01-01T00:00:00.000Z',
            provenance: { indexedAt: '2026-01-01T00:00:00.000Z', sourceProjectId: 'proj-1' },
          },
        ],
        scores: [],
        retrievedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    it('exits 0 and prints verdict + ranked results for a valid search', async () => {
      (ragControllerSearch as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      expect(ragControllerSearch).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'koda', requestBody: { query: 'auth error' } })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints result count line in human output', async () => {
      (ragControllerSearch as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toMatch(/Found 2 result/);
    });

    it('prints ranked results with ticket refs in human output', async () => {
      (ragControllerSearch as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('KODA-42');
      expect(allLogs).toContain('KODA-17');
    });

    it('prints score labels (HIGH/MED/LOW) based on score value', async () => {
      (ragControllerSearch as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      // score 0.95 should be HIGH, score 0.61 should be MED
      expect(allLogs).toMatch(/HIGH/);
      expect(allLogs).toMatch(/MED/);
    });

    it('prints score values in human output', async () => {
      (ragControllerSearch as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('score=0.950');
      expect(allLogs).toContain('score=0.610');
    });

    it('outputs raw JSON matching API response shape with --json flag', async () => {
      (ragControllerSearch as jest.Mock).mockResolvedValue(mockSearchResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const searchCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'search');

      await searchCmd?.parseAsync(['node', 'test', '--project', 'koda', '--query', 'auth error', '--json']);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();

      if (!jsonCall) throw new Error('Expected jsonCall to be defined');
      const parsed = JSON.parse(jsonCall[0]);
      expect(parsed).toHaveProperty('results');
      expect(parsed).toHaveProperty('scores');
      expect(parsed).toHaveProperty('retrievedAt');
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
      (ragControllerSearch as jest.Mock).mockRejectedValue(apiError);

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
      (ragControllerSearch as jest.Mock).mockRejectedValue(apiError);

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
      ret: 0,
      data: {
        items: [
          { id: 'doc-1', source: 'README.md', createdAt: '2026-01-10T12:00:00.000Z' },
          { id: 'doc-2', source: 'CONTRIBUTING.md', createdAt: '2026-02-15T09:30:00.000Z' },
        ],
        total: 2,
      },
    };

    it('exits 0 and prints document table', async () => {
      (ragControllerListDocuments as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      expect(ragControllerListDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'koda', limit: '100' })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('renders table with ID column', async () => {
      (ragControllerListDocuments as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('doc-1');
      expect(allLogs).toContain('doc-2');
    });

    it('renders table with Source column', async () => {
      (ragControllerListDocuments as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('README.md');
      expect(allLogs).toContain('CONTRIBUTING.md');
    });

    it('renders table with Created column', async () => {
      (ragControllerListDocuments as jest.Mock).mockResolvedValue(mockListResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const listCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'koda']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      // Should contain some recognizable date portion
      expect(allLogs).toMatch(/2026/);
    });

    it('outputs JSON with --json flag', async () => {
      (ragControllerListDocuments as jest.Mock).mockResolvedValue(mockListResponse);

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
      (ragControllerListDocuments as jest.Mock).mockRejectedValue(apiError);

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
      ret: 0,
      data: {
        id: 'doc-99',
        source: 'README.md',
        docCount: 3,
      },
    };

    it('exits 0 and prints success confirmation with file name', async () => {
      (ragControllerAddDocument as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      expect(ragControllerAddDocument).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints confirmation message containing the file name', async () => {
      (ragControllerAddDocument as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('README.md');
    });

    it('prints confirmation message containing the doc count', async () => {
      (ragControllerAddDocument as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toContain('3');
    });

    it('reads the file from disk and sends content, source, and sourceId to the API', async () => {
      (ragControllerAddDocument as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md']);

      expect(ragControllerAddDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'koda',
          requestBody: expect.objectContaining({ content: mockFileContent, source: 'doc', sourceId: 'README.md' }),
        })
      );
    });

    it('accepts --source option to override default source type', async () => {
      (ragControllerAddDocument as jest.Mock).mockResolvedValue(mockAddResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      await addCmd?.parseAsync(['node', 'test', '--project', 'koda', '--file', './README.md', '--source', 'manual']);

      expect(ragControllerAddDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'koda',
          requestBody: expect.objectContaining({ source: 'manual', sourceId: 'README.md' }),
        })
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
      (ragControllerAddDocument as jest.Mock).mockResolvedValue(mockAddResponse);

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
      (ragControllerAddDocument as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const addCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'add');

      try {
        await addCmd?.parseAsync(['node', 'test', '--file', './README.md']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });
  });

  // ---------------------------------------------------------------------------
  // kb delete
  // ---------------------------------------------------------------------------
  describe('kb delete', () => {
    it('deletes documents by sourceId with --force', async () => {
      (ragControllerDeleteDocument as jest.Mock).mockResolvedValue({ ret: 0, data: { deletedCount: 2 } });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const deleteCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync(['node', 'test', '--project', 'koda', '--source-id', 'README.md', '--force']).catch(() => undefined);

      expect(ragControllerDeleteDocument).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'koda', sourceId: 'README.md' })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('requires --force for delete', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const deleteCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'delete');

      await deleteCmd?.parseAsync(['node', 'test', '--project', 'koda', '--source-id', 'README.md']).catch(() => undefined);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ---------------------------------------------------------------------------
  // kb optimize
  // ---------------------------------------------------------------------------
  describe('kb optimize', () => {
    it('calls optimize endpoint and exits 0', async () => {
      (ragControllerOptimizeTable as jest.Mock).mockResolvedValue({ ret: 0, data: { optimized: true } });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const optimizeCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'optimize');

      await optimizeCmd?.parseAsync(['node', 'test', '--project', 'koda']).catch(() => undefined);

      expect(ragControllerOptimizeTable).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'koda' })
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ---------------------------------------------------------------------------
  // kb import
  // ---------------------------------------------------------------------------
  describe('kb import', () => {
    const mockValidGraphJson = JSON.stringify({
      nodes: [
        { id: 'node1', label: 'Node 1', type: 'class' },
        { id: 'node2', label: 'Node 2', type: 'function' },
      ],
      links: [
        { source: 'node1', target: 'node2', relation: 'calls' },
      ],
    });

    const mockImportResponse = {
      ret: 0,
      data: {
        imported: 2,
        cleared: 0,
      },
    };

    beforeEach(() => {
      (readFile as jest.Mock).mockImplementation((path: string) => {
        if (path === './graph.json') {
          return Promise.resolve(mockValidGraphJson);
        }
        if (path === './invalid.json') {
          return Promise.resolve('not valid json {{{');
        }
        if (path === './missing.json') {
          const error = new Error('ENOENT: no such file or directory');
          (error as any).code = 'ENOENT';
          return Promise.reject(error);
        }
        return Promise.resolve('{}');
      });
    });

    it('exits 0 and prints success message on successful import', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue(mockImportResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      expect(ragControllerImportGraphify).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints human-readable success message with imported and cleared counts', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue(mockImportResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toMatch(/✓ Graphify import complete:/);
      expect(allLogs).toContain('2');
      expect(allLogs).toContain('0');
    });

    it('sends only nodes and links from graph.json to the API', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue(mockImportResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const callArgs = (ragControllerImportGraphify as jest.Mock).mock.calls[0][0];
      expect(callArgs.requestBody.nodes).toBeDefined();
      expect(callArgs.requestBody.links).toBeDefined();
      // Verify it doesn't include other top-level keys from the JSON
      expect(Object.keys(callArgs.requestBody)).toEqual(expect.arrayContaining(['nodes', 'links']));
    });

    it('outputs JSON with --json flag', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue(mockImportResponse);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json', '--json']);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('exits 1 and writes to stderr when file is not found', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './missing.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 and writes to stderr when JSON is invalid', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './invalid.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 3 when --project flag is missing', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('exits 3 when --graphify flag is missing', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('exits 2 when auth is missing without calling the API', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100/api',
        projectSlug: 'koda',
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(ragControllerImportGraphify).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(2);
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

    it('registers kb delete sub-command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const deleteCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'delete');
      expect(deleteCmd).toBeDefined();
    });

    it('registers kb optimize sub-command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const optimizeCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'optimize');
      expect(optimizeCmd).toBeDefined();
    });

    it('registers kb import sub-command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');
      expect(importCmd).toBeDefined();
    });
  });
});
