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

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { createHmac } from 'node:crypto';
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

  const originalSecret = process.env.KODA_CI_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.KODA_CI_WEBHOOK_SECRET;
    else process.env.KODA_CI_WEBHOOK_SECRET = originalSecret;
    jest.restoreAllMocks();
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

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
          event: 'pipeline_failed',
          pipeline: expect.objectContaining({ id: 'pipe-1' }),
          commit: expect.objectContaining({ sha: 'abc123' }),
        }), path: { slug: 'my-proj' }}));
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

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ event: 'pipeline_success' })}));
    });

    /** Review M1: the API accepts `pipeline_succeeded` too, so the help and the payload must know it. */
    it('documents and forwards pipeline_succeeded', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });
      const trigger = program.commands.find((c) => c.name() === 'ci-webhook')?.commands.find((c) => c.name() === 'trigger');

      expect(trigger?.options.find((o) => o.long === '--event')?.description)
        .toContain('pipeline_failed | pipeline_success | pipeline_succeeded');

      await program.parseAsync([
        'node', 'koda', 'ci-webhook', 'trigger',
        '--event', 'pipeline_succeeded',
        '--pipeline-id', 'pipe-3',
        '--commit-sha', 'aaa111',
      ]);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ event: 'pipeline_succeeded' })}));
    });

    it('passes optional commit message', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync([...BASE_ARGS, '--commit-message', 'fix: crash']);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
          commit: expect.objectContaining({ message: 'fix: crash' }),
        })}));
    });

    it('passes parsed failures JSON array', async () => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });
      const failures = [{ test: 'AuthService.login', file: 'src/auth.ts', line: 42 }];

      await program.parseAsync([...BASE_ARGS, '--failures', JSON.stringify(failures)]);

      expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ failures })}));
    });

    const signedOptions = () => mockTrigger.mock.calls[0][0] as {
      headers: Record<string, string | undefined>;
      body: Record<string, unknown>;
      bodySerializer?: (body: unknown) => string;
    };

    const runSigned = async (extraArgs: string[] = []) => {
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });
      jest.spyOn(Date, 'now').mockReturnValue(1763600000000);
      await program.parseAsync([...BASE_ARGS, ...extraArgs]);
      return signedOptions();
    };

    it('AC-1: sends the fixed v2 timestamp when a secret is configured', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      const options = await runSigned();
      expect(options.headers['x-ci-timestamp']).toBe('1763600000');
    });

    it('AC-2: signs the delivery id and exact serialized body with HMAC-SHA256', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      const options = await runSigned();
      const serialized = options.bodySerializer?.(options.body);
      const signature = createHmac('sha256', 's3cret')
        .update(`1763600000.${options.headers['x-ci-delivery']}.${serialized}`)
        .digest('hex');
      expect(options.headers['x-ci-signature-v2']).toBe(`sha256=${signature}`);
    });

    it('AC-3: sends the exact body that was serialized for signing', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      const options = await runSigned();
      expect(JSON.parse(options.bodySerializer?.(options.body) ?? '')).toEqual(options.body);
    });

    it('AC-4: omits the legacy signature without --signature', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      expect((await runSigned()).headers['x-ci-signature']).toBeUndefined();
    });

    it('AC-5: preserves --signature as the legacy header when v2 is enabled', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      expect((await runSigned(['--signature', 'sha256=abc'])).headers['x-ci-signature']).toBe('sha256=abc');
    });

    it('AC-6: sends v2 signature alongside a legacy signature', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      expect((await runSigned(['--signature', 'sha256=abc'])).headers['x-ci-signature-v2']).toBeTruthy();
    });

    it('AC-7: preserves --signature when the v2 secret is unset', async () => {
      delete process.env.KODA_CI_WEBHOOK_SECRET;
      expect((await runSigned(['--signature', 'sha256=abc'])).headers['x-ci-signature']).toBe('sha256=abc');
    });

    it('AC-8: omits the v2 signature when the secret is unset', async () => {
      delete process.env.KODA_CI_WEBHOOK_SECRET;
      expect((await runSigned()).headers['x-ci-signature-v2']).toBeUndefined();
    });

    it('AC-9: omits the v2 timestamp when the secret is unset', async () => {
      delete process.env.KODA_CI_WEBHOOK_SECRET;
      expect((await runSigned()).headers['x-ci-timestamp']).toBeUndefined();
    });

    it('AC-10: treats an empty secret as unset', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = '';
      expect((await runSigned()).headers['x-ci-signature-v2']).toBeUndefined();
    });

    it('AC-11: generates a distinct delivery id for every trigger call', async () => {
      process.env.KODA_CI_WEBHOOK_SECRET = 's3cret';
      mockTrigger.mockResolvedValue({ ret: 0, data: {} });
      jest.spyOn(Date, 'now').mockReturnValue(1763600000000);
      jest.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.2);
      await program.parseAsync(BASE_ARGS);
      const first = signedOptions().headers['x-ci-delivery'];
      const secondProgram = new Command();
      secondProgram.exitOverride();
      ciWebhookCommand(secondProgram);
      await secondProgram.parseAsync(BASE_ARGS);
      expect((mockTrigger.mock.calls[1][0] as { headers: Record<string, string> }).headers['x-ci-delivery']).not.toBe(first);
    });

    it('AC-12: rejects an unsupported --secret option', async () => {
      const error = await program.parseAsync([...BASE_ARGS, '--secret', 's3cret']).catch((err: unknown) => err as { code?: string });
      expect(error).toEqual(expect.objectContaining({ code: 'commander.unknownOption' }));
    });

    it('AC-13: documents the environment variable in trigger description', () => {
      const trigger = program.commands.find((command) => command.name() === 'ci-webhook')?.commands.find((command) => command.name() === 'trigger');
      expect(trigger?.description()).toContain('KODA_CI_WEBHOOK_SECRET');
    });
  });
});
