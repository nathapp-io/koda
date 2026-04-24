/**
 * evaluate Command CLI Tests
 *
 * RED PHASE: Tests fail because the evaluate command does not exist yet.
 *
 * Acceptance Criteria:
 * AC1: koda evaluate command is registered and responds to --help
 * AC2: koda evaluate exits 0 when evaluation runs successfully
 * AC3: koda evaluate prints a table to stdout with per-query results
 * AC4: koda evaluate --json outputs JSON-serializable evaluation summary
 * AC5: koda evaluate exits 1 when precisionAt5_avg < 0.70 (CI threshold failure)
 * AC6: koda evaluate respects --api-key and --api-url flags
 * AC7: koda evaluate exits 2 when auth credentials are missing
 */
import { Command } from 'commander';

// Mock conf
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
  ragControllerEvaluateRetrieval: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

// Mock config module
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

// Mock chalk
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

import { evaluateCommand } from './evaluate';
import { resolveContext } from '../config';

describe('evaluateCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    evaluateCommand(program);

    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100';
    mockData.projectSlug = 'koda';

    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100',
      projectSlug: 'koda',
    });

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('AC1: command registration and --help', () => {
    it('registers an evaluate command on the program', () => {
      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');
      expect(evaluateCmd).toBeDefined();
    });

    it('responds to --help without throwing', async () => {
      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');
      expect(evaluateCmd).toBeDefined();

      let captured = '';
      const origWrite = process.stdout.write;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = (str: string) => {
        captured += str;
        return true;
      };
      try {
        await evaluateCmd?.parseAsync(['node', 'test', '--help']);
      } catch {
        // Commander exits with 0 on --help, so we expect exitOverride to throw
      }

      expect(captured).toMatch(/evaluate/i);
      process.stdout.write = origWrite;
    });
  });

  describe('AC6: --api-key and --api-url flags', () => {
    it('accepts --api-key flag', async () => {
      (resolveContext as jest.Mock).mockReset();
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100',
        projectSlug: 'koda',
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test', '--api-key', 'sk-custom-key456']);
      } catch {
        // May throw if no API endpoint exists yet
      }

      expect(resolveContext).toHaveBeenCalled();
    });

    it('accepts --api-url flag', async () => {
      (resolveContext as jest.Mock).mockReset();
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: 'sk-test-key123',
        apiUrl: undefined,
        projectSlug: 'koda',
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test', '--api-url', 'http://custom:3100']);
      } catch {
        // May throw if no API endpoint exists yet
      }

      expect(resolveContext).toHaveBeenCalled();
    });
  });

  describe('AC7: auth credentials missing', () => {
    it('exits with code 2 when api key is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100',
        projectSlug: 'koda',
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 2 when api url is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: 'sk-test-key123',
        apiUrl: undefined,
        projectSlug: 'koda',
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('AC3: table output to stdout', () => {
    it('prints results table to stdout when evaluation succeeds', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      (ragControllerEvaluateRetrieval as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          precisionAt5_avg: 0.75,
          precisionAt5_p50: 0.8,
          precisionAt5_p95: 1.0,
          totalQueries: 3,
          results: [
            {
              query: 'auth token error',
              intent: 'answer',
              expectedDocIds: ['ticket-001'],
              actualDocIds: ['ticket-001', 'ticket-002'],
              precisionAt5: 1.0,
              retrievedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              query: 'database pool',
              intent: 'reproduce',
              expectedDocIds: ['ticket-002'],
              actualDocIds: [],
              precisionAt5: 0.0,
              retrievedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toMatch(/precision/i);
      expect(allLogs).toMatch(/0\.75/);
    });
  });

  describe('AC4: --json output', () => {
    it('outputs JSON with --json flag', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      (ragControllerEvaluateRetrieval as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          precisionAt5_avg: 0.75,
          precisionAt5_p50: 0.8,
          precisionAt5_p95: 1.0,
          totalQueries: 2,
          results: [
            {
              query: 'auth token',
              intent: 'answer',
              expectedDocIds: ['ticket-001'],
              actualDocIds: ['ticket-001'],
              precisionAt5: 1.0,
              retrievedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              query: 'db pool',
              intent: 'answer',
              expectedDocIds: ['ticket-999'],
              actualDocIds: [],
              precisionAt5: 0.0,
              retrievedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test', '--json']);
      } catch {
        // Expected
      }

      const jsonCall = logSpy.mock.calls.find((call) => {
        try {
          JSON.parse(call[0]);
          return true;
        } catch {
          return false;
        }
      });
      expect(jsonCall).toBeDefined();

      if (!jsonCall) throw new Error('Expected jsonCall');
      const parsed = JSON.parse(jsonCall[0]);
      expect(parsed).toHaveProperty('precisionAt5_avg');
      expect(parsed).toHaveProperty('precisionAt5_p50');
      expect(parsed).toHaveProperty('precisionAt5_p95');
      expect(parsed).toHaveProperty('totalQueries');
      expect(parsed).toHaveProperty('results');
    });
  });

  describe('AC5: CI threshold failure exits 1', () => {
    it('exits 1 when precisionAt5_avg < 0.70', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      (ragControllerEvaluateRetrieval as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          precisionAt5_avg: 0.5,
          precisionAt5_p50: 0.5,
          precisionAt5_p95: 0.8,
          totalQueries: 4,
          results: [],
        },
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 0 when precisionAt5_avg >= 0.70', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      (ragControllerEvaluateRetrieval as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          precisionAt5_avg: 0.85,
          precisionAt5_p50: 0.9,
          precisionAt5_p95: 1.0,
          totalQueries: 4,
          results: [],
        },
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('AC2: successful evaluation exits 0', () => {
    it('exits 0 when evaluation succeeds and precisionAt5_avg >= threshold', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      (ragControllerEvaluateRetrieval as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          precisionAt5_avg: 0.80,
          precisionAt5_p50: 0.8,
          precisionAt5_p95: 1.0,
          totalQueries: 10,
          results: [],
        },
      });

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('API errors', () => {
    it('exits 1 when API call fails', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      (ragControllerEvaluateRetrieval as jest.Mock).mockRejectedValue(
        new Error('Internal Server Error')
      );

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 on 5xx server error', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      const serverError = new Error('Service Unavailable');
      (serverError as any).response = { status: 503, data: { message: 'Service Unavailable' } };
      (ragControllerEvaluateRetrieval as jest.Mock).mockRejectedValue(serverError);

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 2 on 401 auth error', async () => {
      const { ragControllerEvaluateRetrieval } = require('../generated');
      const apiError = new Error('Unauthorized');
      (apiError as any).response = { status: 401 };
      (ragControllerEvaluateRetrieval as jest.Mock).mockRejectedValue(apiError);

      const evaluateCmd = program.commands.find((cmd) => cmd.name() === 'evaluate');

      try {
        await evaluateCmd?.parseAsync(['node', 'test']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});
