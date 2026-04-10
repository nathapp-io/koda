import { Command } from 'commander';
import { kbCommand } from '../../../src/commands/kb';
import { ragControllerImportGraphify } from '../../../src/generated';
import { resolveContext } from '../../../src/config';

describe('CLI: koda kb import --graphify Command', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    kbCommand(program);

    mockData.apiKey = 'sk-test-key123';
    mockData.apiUrl = 'http://localhost:3100';
    mockData.projectSlug = 'koda';

    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100',
      projectSlug: 'koda',
    });

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      // Do not throw, just record the call
    }) as any);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.clearAllMocks();

    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: 'sk-test-key123',
      apiUrl: 'http://localhost:3100',
      projectSlug: 'koda',
    });
    (ragControllerImportGraphify as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // AC-1: Exit code 0 with success message containing imported and cleared counts
  // ---------------------------------------------------------------------------
  describe('AC-1: Success message with node counts', () => {
    it('exits 0 and prints success message with imported and cleared counts', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          imported: 2,
          cleared: 5,
        },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      expect(exitSpy).toHaveBeenCalledWith(0);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogs).toMatch(/✓\s+Graphify\s+import\s+complete:/i);
      expect(allLogs).toMatch(/2\s+code\s+nodes\s+indexed/);
      expect(allLogs).toMatch(/5\s+cleared/);
    });

    it('message format matches: ✓ Graphify import complete: {imported} code nodes indexed ({cleared} cleared)', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { imported: 10, cleared: 3 },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      // Check for the pattern: ✓ Graphify import complete: 10 code nodes indexed (3 cleared)
      expect(allLogs).toMatch(/✓.*Graphify\s+import\s+complete:\s+10\s+code\s+nodes\s+indexed\s+\(3\s+cleared\)/);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-2: Exit code 0 with JSON output containing nodes and links
  // ---------------------------------------------------------------------------
  describe('AC-2: JSON output with nodes and links', () => {
    it('exits 0 and outputs valid JSON with --json flag', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: {
          imported: 5,
          cleared: 2,
        },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json', '--json']);

      expect(exitSpy).toHaveBeenCalledWith(0);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();

      if (!jsonCall) throw new Error('Expected JSON output');
      const parsed = JSON.parse(jsonCall[0]);
      expect(parsed).toHaveProperty('imported');
      expect(parsed).toHaveProperty('cleared');
      expect(typeof parsed.imported).toBe('number');
      expect(typeof parsed.cleared).toBe('number');
    });

    it('JSON output parses without error', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { imported: 1, cleared: 0 },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json', '--json']);

      const jsonCall = logSpy.mock.calls.find((call) => {
        try { JSON.parse(call[0]); return true; } catch { return false; }
      });
      expect(jsonCall).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // AC-3: Exit code 1 with file not found error
  // ---------------------------------------------------------------------------
  describe('AC-3: File not found error', () => {
    it('exits 1 and writes file-not-found message to stderr when file does not exist', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './missing.json']);

      expect(exitSpy).toHaveBeenCalledWith(1);

      const allErrors = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allErrors.toLowerCase()).toMatch(/file\s+not\s+found|enoent|no\s+such\s+file/i);
    });

    it('does not make API call when file read fails', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './missing.json']);

      expect(ragControllerImportGraphify).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // AC-4: Exit code 1 with JSON parse error
  // ---------------------------------------------------------------------------
  describe('AC-4: JSON parse error', () => {
    it('exits 1 and writes parse-error message to stderr for invalid JSON', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './invalid.json']);

      expect(exitSpy).toHaveBeenCalledWith(1);

      const allErrors = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allErrors.toLowerCase()).toMatch(/invalid\s+json|parse\s+error|syntaxerror|unexpected\s+token/i);
    });

    it('does not make API call when JSON parse fails', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './invalid.json']);

      expect(ragControllerImportGraphify).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // AC-5: Exit code 3 when --graphify flag is missing
  // ---------------------------------------------------------------------------
  describe('AC-5: Missing --graphify flag', () => {
    it('exits 3 when --graphify is not provided', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda']);
      } catch {
        // Commander may throw for missing required option
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-6: Exit code 3 when --project flag is missing
  // ---------------------------------------------------------------------------
  describe('AC-6: Missing --project flag', () => {
    it('exits 3 when --project is not provided', async () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--graphify', './graph.json']);
      } catch {
        // Commander may throw for missing required option
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-7: Exit code 2 when auth is missing, no API call made
  // ---------------------------------------------------------------------------
  describe('AC-7: Missing auth configuration', () => {
    it('exits 2 when API key is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100',
        projectSlug: 'koda',
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('does not make API call when auth is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100',
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
    });

    it('writes auth-related error message to stderr when auth is missing', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: undefined,
        apiUrl: 'http://localhost:3100',
        projectSlug: 'koda',
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      const allErrors = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allErrors.toLowerCase()).toMatch(/api\s+key|not\s+configured|login/i);
    });

    it('exits 2 when project slug is not configured', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        apiKey: 'sk-test-key123',
        apiUrl: 'http://localhost:3100',
        projectSlug: undefined,
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  // ---------------------------------------------------------------------------
  // AC-8: API payload contains only nodes and links, ignoring other top-level keys
  // ---------------------------------------------------------------------------
  describe('AC-8: API payload filtering', () => {
    it('sends only nodes and links to API, ignoring other top-level keys', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { imported: 2, cleared: 0 },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const callArgs = (ragControllerImportGraphify as jest.Mock).mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();

      const requestBody = callArgs.requestBody;
      expect(requestBody).toBeDefined();
      expect(requestBody).toHaveProperty('nodes');
      expect(requestBody).toHaveProperty('links');

      // Ensure no other top-level keys from the source graph.json are included
      const topLevelKeys = Object.keys(requestBody);
      expect(topLevelKeys.sort()).toEqual(['links', 'nodes']);
    });

    it('extracts nodes array from parsed JSON', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { imported: 2, cleared: 0 },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const callArgs = (ragControllerImportGraphify as jest.Mock).mock.calls[0]?.[0];
      const requestBody = callArgs.requestBody;

      expect(Array.isArray(requestBody.nodes)).toBe(true);
      expect(requestBody.nodes.length).toBe(2);
      expect(requestBody.nodes[0]).toHaveProperty('id');
      expect(requestBody.nodes[0]).toHaveProperty('label');
    });

    it('extracts links array from parsed JSON', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { imported: 2, cleared: 0 },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const callArgs = (ragControllerImportGraphify as jest.Mock).mock.calls[0]?.[0];
      const requestBody = callArgs.requestBody;

      expect(Array.isArray(requestBody.links)).toBe(true);
      expect(requestBody.links.length).toBe(1);
      expect(requestBody.links[0]).toHaveProperty('source');
      expect(requestBody.links[0]).toHaveProperty('target');
    });

    it('does not include metadata field in API request', async () => {
      (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { imported: 2, cleared: 0 },
      });

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

      const callArgs = (ragControllerImportGraphify as jest.Mock).mock.calls[0]?.[0];
      const requestBody = callArgs.requestBody;

      expect(requestBody).not.toHaveProperty('metadata');
      expect(requestBody).not.toHaveProperty('extraField');
    });
  });

  // ---------------------------------------------------------------------------
  // Command registration
  // ---------------------------------------------------------------------------
  describe('Command registration', () => {
    it('registers import subcommand under kb command', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');
      expect(importCmd).toBeDefined();
    });

    it('import command requires --project option', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');
      expect(importCmd?.hasOption('--project')).toBe(true);
    });

    it('import command requires --graphify option', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');
      expect(importCmd?.hasOption('--graphify')).toBe(true);
    });

    it('import command supports --json option', () => {
      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');
      expect(importCmd?.hasOption('--json')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------
  describe('Error handling', () => {
    it('handles API errors via handleApiError', async () => {
      const apiError = new Error('Unauthorized');
      (apiError as any).response = { status: 401 };
      (ragControllerImportGraphify as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with 400 status code handling on API validation error', async () => {
      const apiError = new Error('Validation error');
      (apiError as any).response = { status: 400, data: { message: 'Invalid nodes format' } };
      (ragControllerImportGraphify as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('exits with 1 status code on generic API error', async () => {
      const apiError = new Error('Internal Server Error');
      (apiError as any).response = { status: 500 };
      (ragControllerImportGraphify as jest.Mock).mockRejectedValue(apiError);

      const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
      const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

      try {
        await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});