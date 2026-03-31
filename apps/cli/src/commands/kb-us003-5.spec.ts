/**
 * Tests for US-003-5: Wire resolveContext into kbCommand
 *
 * These tests cover:
 * AC-1: projectSlug from .koda/config.json used when --project flag omitted
 * AC-2: exit 2 + "Project not configured. Run: koda init" when projectSlug resolves to undefined
 * AC-3: kb.ts contains no reference to GLOBAL_PROJECT_SLUG
 */

// Mock chalk before any imports to prevent ESM resolution issues
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s },
  gray: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
}));

// Mock conf to prevent real filesystem access to ~/.koda/config
const mockConfData: Record<string, unknown> = {};
jest.mock('conf', () =>
  jest.fn(() => ({
    get: jest.fn((key: string) => (key in mockConfData ? mockConfData[key] : key === 'profiles' ? {} : '')),
    set: jest.fn((key: string, value: unknown) => { mockConfData[key] = value; }),
  })),
);

// Mock the config module — resolveContext
jest.mock('../config', () => ({
  getConfig: jest.fn(() => ({
    apiKey: 'test-key-12345678',
    apiUrl: 'http://localhost:3100/api',
    profiles: {},
  })),
  resolveContext: jest.fn(),
}));

// Mock generated API client
jest.mock('../generated', () => ({
  ragControllerSearch: jest.fn(),
  ragControllerListDocuments: jest.fn(),
  ragControllerAddDocument: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { kbCommand } from './kb';
import { ragControllerSearch, ragControllerListDocuments } from '../generated';
import { resolveContext } from '../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const prog = new Command().exitOverride();
  kbCommand(prog);
  return prog;
}

function getKbSubcommand(prog: Command, name: string): Command | undefined {
  return prog.commands.find(c => c.name() === 'kb')
    ?.commands.find(c => c.name() === name);
}

function captureOutput(
  logSpy: jest.SpyInstance,
  errSpy: jest.SpyInstance,
): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('US-003-5: kbCommand — resolveContext wiring', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    (ragControllerSearch as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { verdict: 'RELEVANT', confidence: 0.95, results: [] },
    });

    (ragControllerListDocuments as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { items: [], total: 0 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * AC-1: When --project is omitted, ragControllerSearch must be called with slug from config.
   */
  it('AC-1: kb search calls ragControllerSearch with slug from config when --project flag is omitted', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'demo',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getKbSubcommand(prog, 'search')?.parseAsync(['node', 'test', '--query', 'test query']).catch(() => undefined);

    expect(ragControllerSearch).toHaveBeenCalled();
    const callArgs = (ragControllerSearch as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ slug: 'demo' });
  });

  /**
   * AC-1b: kb list calls ragControllerListDocuments with slug from config.
   */
  it('AC-1b: kb list calls ragControllerListDocuments with slug from config when --project flag is omitted', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'demo',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getKbSubcommand(prog, 'list')?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(ragControllerListDocuments).toHaveBeenCalled();
    const callArgs = (ragControllerListDocuments as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ slug: 'demo' });
  });

  /**
   * AC-2: When resolveContext returns projectSlug: undefined, exit with code 2.
   */
  it('AC-2: kb search exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: undefined,
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getKbSubcommand(prog, 'search')?.parseAsync(['node', 'test', '--query', 'test query']).catch(() => undefined);

    expect(processExitSpy).toHaveBeenCalledWith(2);
    const out = captureOutput(consoleLogSpy, consoleErrorSpy);
    expect(out).toMatch(/Project not configured/);
    expect(out).toMatch(/koda init/);
  });

  /**
   * AC-2b: kb list exits with code 2 when projectSlug is undefined.
   */
  it('AC-2b: kb list exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: undefined,
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getKbSubcommand(prog, 'list')?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(processExitSpy).toHaveBeenCalledWith(2);
    const out = captureOutput(consoleLogSpy, consoleErrorSpy);
    expect(out).toMatch(/Project not configured/);
  });

  /**
   * AC-3: kb.ts must not contain any reference to GLOBAL_PROJECT_SLUG.
   */
  it('AC-3: kb.ts contains no reference to GLOBAL_PROJECT_SLUG', () => {
    const kbFilePath = join(__dirname, 'kb.ts');
    const contents = readFileSync(kbFilePath, 'utf-8');
    expect(contents).not.toContain('GLOBAL_PROJECT_SLUG');
  });
});
