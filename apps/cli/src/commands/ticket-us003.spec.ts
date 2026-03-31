/**
 * Failing tests for US-003-1: Wire resolveContext into ticketCommand with undefined guard
 *
 * These tests cover:
 * AC-1: projectSlug from .koda/config.json used when --project flag omitted
 * AC-2: --project flag wins regardless of config
 * AC-3: exit 2 + "Project not configured. Run: koda init" when projectSlug resolves to undefined
 * AC-4: ticket.ts contains no reference to GLOBAL_PROJECT_SLUG
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

// Mock the config module — both getConfig (used by current resolveAuth) and resolveContext (new path)
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
  ticketsControllerFindAll: jest.fn(),
  ticketsControllerCreate: jest.fn(),
  ticketsControllerFindByRef: jest.fn(),
  ticketsControllerUpdate: jest.fn(),
  ticketsControllerSoftDelete: jest.fn(),
  ticketsControllerAssign: jest.fn(),
  ticketsControllerVerify: jest.fn(),
  ticketsControllerStart: jest.fn(),
  ticketsControllerFix: jest.fn(),
  ticketsControllerVerifyFix: jest.fn(),
  ticketsControllerClose: jest.fn(),
  ticketsControllerReject: jest.fn(),
  ticketLinksControllerCreate: jest.fn(),
  ticketLinksControllerFindAll: jest.fn(),
  ticketLinksControllerRemove: jest.fn(),
  labelsControllerAssignLabelFromHttp: jest.fn(),
  labelsControllerRemoveLabelFromHttp: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { ticketCommand } from './ticket';
import { ticketsControllerFindAll } from '../generated';
import { resolveContext } from '../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const prog = new Command().exitOverride();
  ticketCommand(prog);
  return prog;
}

function getListCmd(prog: Command): Command | undefined {
  return prog.commands.find(c => c.name() === 'ticket')
    ?.commands.find(c => c.name() === 'list');
}

function captureOutput(
  logSpy: jest.SpyInstance,
  errSpy: jest.SpyInstance,
): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('US-003-1: ticketCommand list — resolveContext wiring', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    (ticketsControllerFindAll as jest.Mock).mockResolvedValue({
      ret: 0,
      data: { items: [], total: 0 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'configured-project',
   * ticketsControllerFindAll must be called with that slug.
   */
  it('AC-1: calls ticketsControllerFindAll with slug from config when --project flag is omitted', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'configured-project',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getListCmd(prog)?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(ticketsControllerFindAll).toHaveBeenCalled();
    const callOpts = (ticketsControllerFindAll as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callOpts).toMatchObject({ slug: 'configured-project' });
  });

  /**
   * AC-2: When --project foo is passed, ticketsControllerFindAll must receive slug: 'foo'.
   */
  it('AC-2: calls ticketsControllerFindAll with slug "foo" when --project foo is passed', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'foo',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getListCmd(prog)?.parseAsync(['node', 'test', '--project', 'foo']).catch(() => undefined);

    expect(ticketsControllerFindAll).toHaveBeenCalled();
    const callOpts = (ticketsControllerFindAll as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callOpts).toMatchObject({ slug: 'foo' });
  });

  /**
   * AC-3: When resolveContext returns projectSlug: undefined, exit with code 2.
   */
  it('AC-3: exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: undefined,
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getListCmd(prog)?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(processExitSpy).toHaveBeenCalledWith(2);
    const out = captureOutput(consoleLogSpy, consoleErrorSpy);
    expect(out).toMatch(/Project not configured/);
    expect(out).toMatch(/koda init/);
  });

  /**
   * AC-4: ticket.ts must not contain any reference to GLOBAL_PROJECT_SLUG.
   */
  it('AC-4: ticket.ts contains no reference to GLOBAL_PROJECT_SLUG', () => {
    const ticketFilePath = join(__dirname, 'ticket.ts');
    const contents = readFileSync(ticketFilePath, 'utf-8');
    expect(contents).not.toContain('GLOBAL_PROJECT_SLUG');
  });
});
