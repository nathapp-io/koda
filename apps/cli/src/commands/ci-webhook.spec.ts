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
  ciWebhookControllerHandleCiWebhook: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { ciWebhookCommand } from './ci-webhook';
import { ciWebhookControllerHandleCiWebhook } from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockTrigger = ciWebhookControllerHandleCiWebhook as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('ciWebhookCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    ciWebhookCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('trigger', () => {
    const BASE_ARGS = [
      'node', 'koda', 'ci-webhook', 'trigger',
      '--event', 'pipeline_failed',
      '--pipeline-id', 'pipe-1',
      '--commit-sha', 'abc123',
    ];

    it('sends CI event and prints success message', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync(BASE_ARGS);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({
        slug: 'my-proj',
        requestBody: expect.objectContaining({
          event: 'pipeline_failed',
          pipeline: expect.objectContaining({ id: 'pipe-1' }),
          commit: expect.objectContaining({ sha: 'abc123' }),
        }),
      }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const result = { accepted: true };
      mockTrigger.mockResolvedValue({ ret: 0, data: result });

      await program.parseAsync([...BASE_ARGS, '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    });

    it('passes pipeline_success event type', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync([
        'node', 'koda', 'ci-webhook', 'trigger',
        '--event', 'pipeline_success',
        '--pipeline-id', 'pipe-2',
        '--commit-sha', 'def456',
      ]);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({ event: 'pipeline_success' }),
      }));
    });

    it('passes optional commit message', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync([...BASE_ARGS, '--commit-message', 'fix: crash']);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          commit: expect.objectContaining({ message: 'fix: crash' }),
        }),
      }));
    });

    it('passes parsed failures JSON array', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });
      const failures = [{ test: 'AuthService.login', file: 'src/auth.ts', line: 42 }];

      await program.parseAsync([...BASE_ARGS, '--failures', JSON.stringify(failures)]);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({ failures }),
      }));
    });
  });
});
