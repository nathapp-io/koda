/**
 * Failing tests for US-003-3: Wire resolveContext into labelCommand
 *
 * These tests cover:
 * AC-1: projectSlug from .koda/config.json used when --project flag omitted
 * AC-2: exit 2 + "Project not configured. Run: koda init" when projectSlug is undefined
 * AC-3: label.ts contains no reference to GLOBAL_PROJECT_SLUG
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
  LabelsService: {
    create: jest.fn(),
    list: jest.fn(),
    delete: jest.fn(),
    addToTicket: jest.fn(),
    removeFromTicket: jest.fn(),
  },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import { labelCommand } from './label';
import { LabelsService } from '../generated';
import { resolveContext } from '../config';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const prog = new Command().exitOverride();
  labelCommand(prog);
  return prog;
}

function getCreateCmd(prog: Command): Command | undefined {
  return prog.commands.find(c => c.name() === 'label')
    ?.commands.find(c => c.name() === 'create');
}

function getListCmd(prog: Command): Command | undefined {
  return prog.commands.find(c => c.name() === 'label')
    ?.commands.find(c => c.name() === 'list');
}

function getDeleteCmd(prog: Command): Command | undefined {
  return prog.commands.find(c => c.name() === 'label')
    ?.commands.find(c => c.name() === 'delete');
}

function captureOutput(
  logSpy: jest.SpyInstance,
  errSpy: jest.SpyInstance,
): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(' ');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('US-003-3: labelCommand — resolveContext wiring', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    (LabelsService.create as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: { id: 'lbl-1', name: 'Bug', color: '#ff0000' } },
    });

    (LabelsService.list as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: { items: [], total: 0 } },
    });

    (LabelsService.delete as jest.Mock).mockResolvedValue({
      data: { ret: 0, data: null },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('label create', () => {
    /**
     * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'configured-project',
     * LabelsService.create must be called with that projectSlug.
     *
     * RED reason: current code requires --project and uses resolveAuth, never calls resolveContext.
     */
    it('AC-1: calls LabelsService.create with projectSlug from config when --project flag is omitted', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'configured-project',
        apiKey: 'test-key-12345678',
        apiUrl: 'http://localhost:3100/api',
      });

      const prog = buildProgram();
      await getCreateCmd(prog)?.parseAsync(['node', 'test', '--name', 'Bug']).catch(() => undefined);

      expect(LabelsService.create).toHaveBeenCalled();
      const callOpts = (LabelsService.create as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(callOpts).toMatchObject({ projectSlug: 'configured-project', name: 'Bug' });
    });

    /**
     * AC-2: When resolveContext returns projectSlug: undefined (no config, no flag),
     * the command must exit with code 2 and print the setup hint.
     *
     * RED reason: current code requires --project, so it fails before reaching this logic.
     */
    it('AC-2: exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: undefined,
        apiKey: 'test-key-12345678',
        apiUrl: 'http://localhost:3100/api',
      });

      const prog = buildProgram();
      await getCreateCmd(prog)?.parseAsync(['node', 'test', '--name', 'Bug']).catch(() => undefined);

      expect(processExitSpy).toHaveBeenCalledWith(2);
      const out = captureOutput(consoleLogSpy, consoleErrorSpy);
      expect(out).toMatch(/Project not configured/);
      expect(out).toMatch(/koda init/);
    });
  });

  describe('label list', () => {
    /**
     * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'configured-project',
     * LabelsService.list must be called with that projectSlug.
     */
    it('AC-1: calls LabelsService.list with projectSlug from config when --project flag is omitted', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'configured-project',
        apiKey: 'test-key-12345678',
        apiUrl: 'http://localhost:3100/api',
      });

      const prog = buildProgram();
      await getListCmd(prog)?.parseAsync(['node', 'test']).catch(() => undefined);

      expect(LabelsService.list).toHaveBeenCalled();
      const callArg = (LabelsService.list as jest.Mock).mock.calls[0][1] as string;
      expect(callArg).toBe('configured-project');
    });

    /**
     * AC-2: When resolveContext returns projectSlug: undefined,
     * exit with code 2 and print setup hint.
     */
    it('AC-2: exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
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
  });

  describe('label delete', () => {
    /**
     * AC-1: When --project is omitted and .koda/config.json has projectSlug: 'configured-project',
     * LabelsService.delete must be called with that projectSlug.
     */
    it('AC-1: calls LabelsService.delete with projectSlug from config when --project flag is omitted', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: 'configured-project',
        apiKey: 'test-key-12345678',
        apiUrl: 'http://localhost:3100/api',
      });

      const prog = buildProgram();
      await getDeleteCmd(prog)?.parseAsync(['node', 'test', '--id', 'lbl-1']).catch(() => undefined);

      expect(LabelsService.delete).toHaveBeenCalled();
      const [, projectSlug] = (LabelsService.delete as jest.Mock).mock.calls[0];
      expect(projectSlug).toBe('configured-project');
    });

    /**
     * AC-2: When resolveContext returns projectSlug: undefined,
     * exit with code 2 and print setup hint.
     */
    it('AC-2: exits with code 2 and prints setup hint when projectSlug is undefined', async () => {
      (resolveContext as jest.Mock).mockResolvedValue({
        projectSlug: undefined,
        apiKey: 'test-key-12345678',
        apiUrl: 'http://localhost:3100/api',
      });

      const prog = buildProgram();
      await getDeleteCmd(prog)?.parseAsync(['node', 'test', '--id', 'lbl-1']).catch(() => undefined);

      expect(processExitSpy).toHaveBeenCalledWith(2);
      const out = captureOutput(consoleLogSpy, consoleErrorSpy);
      expect(out).toMatch(/Project not configured/);
      expect(out).toMatch(/koda init/);
    });
  });

  /**
   * AC-3: label.ts must not contain any reference to GLOBAL_PROJECT_SLUG after the change.
   */
  it('AC-3: label.ts contains no reference to GLOBAL_PROJECT_SLUG', () => {
    const labelFilePath = join(__dirname, 'label.ts');
    const contents = readFileSync(labelFilePath, 'utf-8');
    expect(contents).not.toContain('GLOBAL_PROJECT_SLUG');
  });
});
