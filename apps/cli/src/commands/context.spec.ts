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
  contextControllerGetContext: jest.fn(),
  contextControllerQueryContext: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { contextCommand } from './context';
import {
  contextControllerGetContext,
  contextControllerQueryContext,
} from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockGetContext = contextControllerGetContext as jest.Mock;
const mockQueryContext = contextControllerQueryContext as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };
const PROJECT_ID = 'proj-uuid-123';

describe('contextCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    contextCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('fetches and prints project context as JSON', async () => {
      const contextData = { projectId: PROJECT_ID, canonicalState: { tickets: [] } };
      mockGetContext.mockResolvedValue({ ret: 0, data: contextData });

      await program.parseAsync(['node', 'koda', 'context', 'get', '--project-id', PROJECT_ID]);

      expect(mockGetContext).toHaveBeenCalledWith({ projectId: PROJECT_ID });
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(contextData, null, 2));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('handles project not found', async () => {
      const err = Object.assign(new Error('Not found'), { status: 404 });
      mockGetContext.mockRejectedValue(err);

      await program.parseAsync(['node', 'koda', 'context', 'get', '--project-id', PROJECT_ID]);

      expect(exitSpy).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  describe('query', () => {
    it('queries context with a prompt and prints result', async () => {
      const result = { answer: 'some context' };
      mockQueryContext.mockResolvedValue({ ret: 0, data: result });

      await program.parseAsync([
        'node', 'koda', 'context', 'query',
        '--project-id', PROJECT_ID,
        '--query', 'what is broken',
        '--intent', 'diagnose',
      ]);

      expect(mockQueryContext).toHaveBeenCalledWith(expect.objectContaining({
        projectId: PROJECT_ID,
        requestBody: expect.objectContaining({ query: 'what is broken', intent: 'diagnose' }),
      }));
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('passes ticket-ids and token-budget', async () => {
      mockQueryContext.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync([
        'node', 'koda', 'context', 'query',
        '--project-id', PROJECT_ID,
        '--ticket-ids', 'tid-1,tid-2',
        '--token-budget', '4000',
      ]);

      expect(mockQueryContext).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          ticketIds: ['tid-1', 'tid-2'],
          tokenBudget: 4000,
        }),
      }));
    });
  });
});
