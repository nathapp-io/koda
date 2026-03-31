/**
 * Failing tests for US-003-4: Wire resolveContext into agentCommand
 *
 * These tests cover:
 * AC-1: projectSlug from .koda/config.json used when --project flag omitted
 * AC-2: --project flag wins regardless of config
 * AC-3: exit 2 + "Project not configured. Run: koda init" when projectSlug resolves to undefined
 * AC-4: agent.ts contains no reference to GLOBAL_PROJECT_SLUG
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
  agentsControllerFindMe: jest.fn(),
  agentsControllerSuggestTicket: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../generated/core/OpenAPI', () => ({
  OpenAPI: { BASE: '', TOKEN: '' },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { agentCommand } from './agent';
import { agentsControllerFindMe, agentsControllerSuggestTicket } from '../generated';
import { resolveContext } from '../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const prog = new Command().exitOverride();
  agentCommand(prog);
  return prog;
}

function getPickupCmd(prog: Command): Command | undefined {
  return prog.commands.find(c => c.name() === 'agent')
    ?.commands.find(c => c.name() === 'pickup');
}

function captureOutput(
  logSpy: jest.SpyInstance,
  errSpy: jest.SpyInstance,
): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('US-003-4: agentCommand pickup — resolveContext wiring', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const mockAgent = {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    apiKey: 'sk-test-key123',
  };

  const mockPickupResult = {
    ticket: {
      id: 'ticket-1',
      number: 42,
      title: 'Fix the login bug',
      status: 'VERIFIED',
      priority: 'HIGH',
    },
    matchScore: 2,
    matchedCapabilities: ['nestjs', 'prisma'],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    (agentsControllerFindMe as jest.Mock).mockResolvedValue({
      ret: 0,
      data: mockAgent,
    });

    (agentsControllerSuggestTicket as jest.Mock).mockResolvedValue({
      ret: 0,
      data: mockPickupResult,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'configured-project',
   * agentsControllerSuggestTicket must be called with that projectSlug.
   */
  it('AC-1: calls agentsControllerSuggestTicket with projectSlug from config when --project flag is omitted', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'configured-project',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getPickupCmd(prog)?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(agentsControllerSuggestTicket).toHaveBeenCalled();
    const callArgs = (agentsControllerSuggestTicket as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ project: 'configured-project' });
  });

  /**
   * AC-2: When --project foo is passed, agentsControllerSuggestTicket must receive project: 'foo'.
   */
  it('AC-2: calls agentsControllerSuggestTicket with project "foo" when --project foo is passed', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'foo',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getPickupCmd(prog)?.parseAsync(['node', 'test', '--project', 'foo']).catch(() => undefined);

    expect(agentsControllerSuggestTicket).toHaveBeenCalled();
    const callArgs = (agentsControllerSuggestTicket as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ project: 'foo' });
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
    await getPickupCmd(prog)?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(processExitSpy).toHaveBeenCalledWith(2);
    const out = captureOutput(consoleLogSpy, consoleErrorSpy);
    expect(out).toMatch(/Project not configured/);
    expect(out).toMatch(/koda init/);
  });

  /**
   * AC-4: agent.ts must not contain any reference to GLOBAL_PROJECT_SLUG.
   */
  it('AC-4: agent.ts contains no reference to GLOBAL_PROJECT_SLUG', () => {
    const agentFilePath = join(__dirname, 'agent.ts');
    const contents = readFileSync(agentFilePath, 'utf-8');
    expect(contents).not.toContain('GLOBAL_PROJECT_SLUG');
  });
});
