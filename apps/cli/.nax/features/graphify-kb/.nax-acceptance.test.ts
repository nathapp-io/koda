import { Command } from 'commander';
import { kbCommand } from '../../../src/commands/kb';
import { ragControllerImportGraphify } from '../../../src/generated';
import { resolveContext } from '../../../src/config';
import { readFile } from 'fs/promises';

describe('Acceptance Tests: graphify-kb feature (koda kb import --graphify)', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
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

    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // AC-1: Success with status 0, human output with pattern
  // ---------------------------------------------------------------------------
  it('AC-1: Command exits with status code 0 and stdout contains success message with node counts', async () => {
    const validGraph = JSON.stringify({
      nodes: [
        { id: 'node-1', label: 'MyClass', type: 'class', source_file: 'src/MyClass.ts' },
        { id: 'node-2', label: 'myMethod', type: 'function', source_file: 'src/MyClass.ts' },
      ],
      links: [
        { source: 'node-1', target: 'node-2', relation: 'contains' },
      ],
    });

    (readFile as jest.Mock).mockResolvedValue(validGraph);
    (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { imported: 2, cleared: 0 },
    });

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

    // Verify exit code is 0
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Verify output contains pattern matching "✓ Graphify import complete: {imported} code nodes indexed ({cleared} cleared)"
    const allLogs = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(allLogs).toMatch(/Graphify import complete: \d+ code nodes indexed \(\d+ cleared\)/);
    expect(allLogs).toContain('2');
    expect(allLogs).toContain('0');
  });

  // ---------------------------------------------------------------------------
  // AC-2: Success with --json flag, valid JSON output
  // ---------------------------------------------------------------------------
  it('AC-2: Command exits with status code 0 and stdout contains valid JSON with import result properties', async () => {
    const validGraph = JSON.stringify({
      nodes: [{ id: 'node-1', label: 'Test' }],
      links: [],
    });

    (readFile as jest.Mock).mockResolvedValue(validGraph);
    (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { imported: 1, cleared: 2 },
    });

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    await importCmd?.parseAsync([
      'node',
      'test',
      '--project',
      'koda',
      '--graphify',
      './graph.json',
      '--json',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(0);

    // Find and parse JSON output
    const jsonCall = logSpy.mock.calls.find((call) => {
      try {
        JSON.parse(call[0]);
        return true;
      } catch {
        return false;
      }
    });

    expect(jsonCall).toBeDefined();
    if (!jsonCall) throw new Error('Expected JSON output to be logged');

    const parsed = JSON.parse(jsonCall[0]);
    expect(parsed).toHaveProperty('data');
    expect(parsed.data).toHaveProperty('imported');
    expect(parsed.data).toHaveProperty('cleared');
    expect(parsed.data.imported).toBe(1);
    expect(parsed.data.cleared).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // AC-3: File not found error, exit 1
  // ---------------------------------------------------------------------------
  it('AC-3: Command exits with status code 1 and stderr contains file-not-found error message', async () => {
    const fileError = new Error('ENOENT: no such file or directory, open \'./missing.json\'');
    (fileError as any).code = 'ENOENT';

    (readFile as jest.Mock).mockRejectedValue(fileError);

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    try {
      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './missing.json']);
    } catch {
      // Expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);

    const allErrors = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(allErrors.toLowerCase()).toMatch(/file|not found|enoent|no such file/i);
  });

  // ---------------------------------------------------------------------------
  // AC-4: Invalid JSON content, exit 1
  // ---------------------------------------------------------------------------
  it('AC-4: Command exits with status code 1 when file contains non-JSON, stderr contains parse error', async () => {
    const invalidJson = 'not valid json {[ broken';
    (readFile as jest.Mock).mockResolvedValue(invalidJson);

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    try {
      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './invalid.json']);
    } catch {
      // Expected
    }

    expect(exitSpy).toHaveBeenCalledWith(1);

    const allErrors = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(allErrors.toLowerCase()).toMatch(/json|parse|unexpected|invalid/i);
  });

  // ---------------------------------------------------------------------------
  // AC-5: Missing --project flag, exit 3
  // ---------------------------------------------------------------------------
  it('AC-5: Command exits with status code 3 when --project flag is omitted', async () => {
    const validGraph = JSON.stringify({ nodes: [], links: [] });
    (readFile as jest.Mock).mockResolvedValue(validGraph);

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    try {
      await importCmd?.parseAsync(['node', 'test', '--graphify', './graph.json']);
    } catch {
      // Expected: Commander may throw for missing required option
    }

    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  // ---------------------------------------------------------------------------
  // AC-6: Missing --graphify flag, exit 3
  // ---------------------------------------------------------------------------
  it('AC-6: Command exits with status code 3 when --graphify flag is omitted', async () => {
    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    try {
      await importCmd?.parseAsync(['node', 'test', '--project', 'koda']);
    } catch {
      // Expected: Commander may throw for missing required option
    }

    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  // ---------------------------------------------------------------------------
  // AC-7: Missing auth config, exit 2, no API call made
  // ---------------------------------------------------------------------------
  it('AC-7: Command exits with status code 2 when auth is missing, no HTTP request made to API', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      apiKey: undefined,
      apiUrl: 'http://localhost:3100/api',
      projectSlug: 'koda',
    });

    const validGraph = JSON.stringify({ nodes: [], links: [] });
    (readFile as jest.Mock).mockResolvedValue(validGraph);

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    try {
      await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);
    } catch {
      // Expected
    }

    expect(exitSpy).toHaveBeenCalledWith(2);
    // Verify the API was never called
    expect(ragControllerImportGraphify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC-8: API request body contains only nodes and links, other keys excluded
  // ---------------------------------------------------------------------------
  it('AC-8: API request body contains only nodes and links from input file, other top-level keys excluded', async () => {
    const graphWithExtra = JSON.stringify({
      nodes: [
        { id: 'n1', label: 'Component', type: 'class', source_file: 'src/index.ts' },
      ],
      links: [{ source: 'n1', target: 'n2', relation: 'imports' }],
      metadata: { version: '1.0', author: 'test' },
      description: 'Extra field',
      config: { setting: true },
    });

    (readFile as jest.Mock).mockResolvedValue(graphWithExtra);
    (ragControllerImportGraphify as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { imported: 1, cleared: 0 },
    });

    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');

    await importCmd?.parseAsync(['node', 'test', '--project', 'koda', '--graphify', './graph.json']);

    // Verify the API was called with only nodes and links in requestBody
    expect(ragControllerImportGraphify).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'koda',
        requestBody: expect.objectContaining({
          nodes: expect.any(Array),
          links: expect.any(Array),
        }),
      })
    );

    // Verify the requestBody does NOT contain extra keys
    const call = (ragControllerImportGraphify as jest.Mock).mock.calls[0][0];
    const requestBodyKeys = Object.keys(call.requestBody);
    expect(requestBodyKeys).toEqual(expect.arrayContaining(['nodes', 'links']));
    expect(requestBodyKeys).not.toContain('metadata');
    expect(requestBodyKeys).not.toContain('description');
    expect(requestBodyKeys).not.toContain('config');
  });

  // ---------------------------------------------------------------------------
  // Command Registration
  // ---------------------------------------------------------------------------
  it('registers kb import sub-command', () => {
    const kbCmd = program.commands.find((cmd) => cmd.name() === 'kb');
    const importCmd = kbCmd?.commands.find((cmd) => cmd.name() === 'import');
    expect(importCmd).toBeDefined();
  });
});