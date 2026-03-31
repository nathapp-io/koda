/**
 * Tests for US-003-2: Wire resolveContext into commentCommand
 *
 * These tests cover:
 * AC-1: projectSlug from .koda/config.json used when --project flag omitted
 * AC-2: exit 2 + "Project not configured. Run: koda init" when projectSlug resolves to undefined
 * AC-3: comment.ts contains no reference to GLOBAL_PROJECT_SLUG
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

// Mock the config module — both getConfig and resolveContext
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
  commentsControllerCreateFromHttp: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { commentCommand } from './comment';
import { commentsControllerCreateFromHttp } from '../generated';
import { resolveContext } from '../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const prog = new Command().exitOverride();
  commentCommand(prog);
  return prog;
}

function getAddCmd(prog: Command): Command | undefined {
  return prog.commands.find(c => c.name() === 'comment')
    ?.commands.find(c => c.name() === 'add');
}

function captureOutput(
  logSpy: jest.SpyInstance,
  errSpy: jest.SpyInstance,
): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('US-003-2: commentCommand add — resolveContext wiring', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    (commentsControllerCreateFromHttp as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { id: 'c1', type: 'GENERAL', body: 'test comment' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'demo',
   * commentsControllerCreateFromHttp must be called with slug: 'demo'.
   */
  it('AC-1: calls commentsControllerCreateFromHttp with slug from config when --project flag is omitted', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'demo',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getAddCmd(prog)?.parseAsync(['node', 'test', 'KODA-42', '--body', 'test comment']).catch(() => undefined);

    expect(commentsControllerCreateFromHttp).toHaveBeenCalled();
    const callArgs = (commentsControllerCreateFromHttp as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ slug: 'demo' });
  });

  /**
   * AC-2: When resolveContext returns projectSlug: undefined, exit with code 2.
   */
  it('AC-2: exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: undefined,
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getAddCmd(prog)?.parseAsync(['node', 'test', 'KODA-42', '--body', 'test comment']).catch(() => undefined);

    expect(processExitSpy).toHaveBeenCalledWith(2);
    const out = captureOutput(consoleLogSpy, consoleErrorSpy);
    expect(out).toMatch(/Project not configured/);
    expect(out).toMatch(/koda init/);
  });

  /**
   * AC-3: comment.ts must not contain any reference to GLOBAL_PROJECT_SLUG.
   */
  it('AC-3: comment.ts contains no reference to GLOBAL_PROJECT_SLUG', () => {
    const commentFilePath = join(__dirname, 'comment.ts');
    const contents = readFileSync(commentFilePath, 'utf-8');
    expect(contents).not.toContain('GLOBAL_PROJECT_SLUG');
  });
});
