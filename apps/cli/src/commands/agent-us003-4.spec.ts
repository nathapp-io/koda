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

// Mock axios to prevent real HTTP calls
jest.mock('axios', () => ({ create: jest.fn(() => ({})) }));

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
  AgentService: {
    me: jest.fn(),
    pickup: jest.fn(),
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { agentCommand } from './agent';
import { AgentService } from '../generated';
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

    (AgentService.me as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: mockAgent },
    });

    (AgentService.pickup as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: mockPickupResult },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'configured-project',
   * AgentService.pickup must be called with that projectSlug — not the old hardcoded 'koda' fallback.
   *
   * RED reason: current code does NOT use resolveContext in pickup action,
   * and requires --project flag explicitly.
   */
  it('AC-1: calls AgentService.pickup with projectSlug from config when --project flag is omitted', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'configured-project',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getPickupCmd(prog)?.parseAsync(['node', 'test']).catch(() => undefined);

    expect(AgentService.pickup).toHaveBeenCalled();
    const callArgs = (AgentService.pickup as jest.Mock).mock.calls[0];
    expect(callArgs[2]).toBe('configured-project');
  });

  /**
   * AC-2: When --project foo is passed, AgentService.pickup must receive 'foo'
   * regardless of what .koda/config.json contains.
   *
   * This verifies the flag-takes-precedence behaviour.
   */
  it('AC-2: calls AgentService.pickup with projectSlug "foo" when --project foo is passed', async () => {
    (resolveContext as jest.Mock).mockResolvedValue({
      projectSlug: 'foo',
      apiKey: 'test-key-12345678',
      apiUrl: 'http://localhost:3100/api',
    });

    const prog = buildProgram();
    await getPickupCmd(prog)?.parseAsync(['node', 'test', '--project', 'foo']).catch(() => undefined);

    expect(AgentService.pickup).toHaveBeenCalled();
    const callArgs = (AgentService.pickup as jest.Mock).mock.calls[0];
    expect(callArgs[2]).toBe('foo');
  });

  /**
   * AC-3: When resolveContext returns projectSlug: undefined (no config, no flag),
   * the command must exit with code 2 and print the setup hint.
   *
   * RED reason: current code requires --project and exits with code 3 if missing.
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
   * AC-4: agent.ts must not contain any reference to GLOBAL_PROJECT_SLUG after the change.
   */
  it('AC-4: agent.ts contains no reference to GLOBAL_PROJECT_SLUG', () => {
    const agentFilePath = join(__dirname, 'agent.ts');
    const contents = readFileSync(agentFilePath, 'utf-8');
    expect(contents).not.toContain('GLOBAL_PROJECT_SLUG');
  });
});
