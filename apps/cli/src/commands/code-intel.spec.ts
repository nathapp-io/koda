jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s },
  gray: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
}));

const mockData: Record<string, string> = {};
const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => { mockData[key] = value; }),
};
jest.mock('conf', () => jest.fn(() => mockStore));

jest.mock('../generated', () => ({
  codeIntelControllerGetSymbol: jest.fn(),
  codeIntelControllerGetCallers: jest.fn(),
  codeIntelControllerGetCallees: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { codeIntelCommand } from './code-intel';
import {
  codeIntelControllerGetSymbol,
  codeIntelControllerGetCallers,
  codeIntelControllerGetCallees,
} from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockGetSymbol = codeIntelControllerGetSymbol as jest.Mock;
const mockGetCallers = codeIntelControllerGetCallers as jest.Mock;
const mockGetCallees = codeIntelControllerGetCallees as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };
const SYMBOL_ID = 'repo-1:src/auth.ts::AuthService';

describe('codeIntelCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    codeIntelCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('symbol', () => {
    it('fetches and prints a symbol as a table', async () => {
      const sym = { id: SYMBOL_ID, name: 'AuthService', kind: 'class', file: 'src/auth.ts', startLine: 10, endLine: 50 };
      mockGetSymbol.mockResolvedValue({ ret: 0, data: sym });

      await program.parseAsync(['node', 'koda', 'code-intel', 'symbol', '--symbol-id', SYMBOL_ID]);

      expect(mockGetSymbol).toHaveBeenCalledWith(expect.objectContaining({ symbolId: SYMBOL_ID }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const sym = { id: SYMBOL_ID, name: 'AuthService', kind: 'class', file: 'src/auth.ts', startLine: 10, endLine: 50 };
      mockGetSymbol.mockResolvedValue({ ret: 0, data: sym });

      await program.parseAsync(['node', 'koda', 'code-intel', 'symbol', '--symbol-id', SYMBOL_ID, '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(sym, null, 2));
    });

    it('handles symbol not found', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockGetSymbol.mockRejectedValue(err);

      await program.parseAsync(['node', 'koda', 'code-intel', 'symbol', '--symbol-id', SYMBOL_ID]);

      expect(exitSpy).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  describe('callers', () => {
    it('lists callers and prints a table', async () => {
      const callers = [{ symbolId: 'repo-1:src/app.ts::bootstrap', name: 'bootstrap', file: 'src/app.ts' }];
      mockGetCallers.mockResolvedValue({ ret: 0, data: callers });

      await program.parseAsync(['node', 'koda', 'code-intel', 'callers', '--symbol-id', SYMBOL_ID]);

      expect(mockGetCallers).toHaveBeenCalledWith(expect.objectContaining({ symbolId: SYMBOL_ID }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const callers = [{ symbolId: 'repo-1:src/app.ts::bootstrap', name: 'bootstrap', file: 'src/app.ts' }];
      mockGetCallers.mockResolvedValue({ ret: 0, data: callers });

      await program.parseAsync(['node', 'koda', 'code-intel', 'callers', '--symbol-id', SYMBOL_ID, '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(callers, null, 2));
    });
  });

  describe('callees', () => {
    it('lists callees and prints a table', async () => {
      const callees = [{ symbolId: 'repo-1:src/db.ts::query', name: 'query', file: 'src/db.ts' }];
      mockGetCallees.mockResolvedValue({ ret: 0, data: callees });

      await program.parseAsync(['node', 'koda', 'code-intel', 'callees', '--symbol-id', SYMBOL_ID]);

      expect(mockGetCallees).toHaveBeenCalledWith(expect.objectContaining({ symbolId: SYMBOL_ID }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const callees = [{ symbolId: 'repo-1:src/db.ts::query', name: 'query', file: 'src/db.ts' }];
      mockGetCallees.mockResolvedValue({ ret: 0, data: callees });

      await program.parseAsync(['node', 'koda', 'code-intel', 'callees', '--symbol-id', SYMBOL_ID, '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(callees, null, 2));
    });
  });
});
