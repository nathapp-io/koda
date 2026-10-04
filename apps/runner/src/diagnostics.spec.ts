import { afterAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../test/helpers/tmp';
import { readDiagnosticTail, sanitizeDiagnostic } from './diagnostics';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

describe('diagnostics', () => {
  test('normalizes terminal formatting before masking known environment secrets', () => {
    const env = { API_KEY: 'private-service-token' };
    expect(sanitizeDiagnostic('plugin rejected credential: private-\u001b[31mservice\u001b[0m-token', env))
      .toBe('plugin rejected credential: [redacted]');
    expect(sanitizeDiagnostic('plugin rejected credential: private-\u0000service-token', env))
      .toBe('plugin rejected credential: [redacted]');
  });
  test('masks HTTP Basic credentials in diagnostics', () => {
    expect(sanitizeDiagnostic('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
  });
  test('masks Telegram tokens embedded in bot URLs even when absent from the daemon environment', () => {
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const clean = sanitizeDiagnostic(`https://api.telegram.org/bot${token}/getMe`, {});
    expect(clean).not.toContain(token);
    expect(clean).toContain('/getMe');
  });
  test('masks environment secrets, URL credentials, bearer tokens and secret assignments before truncating', () => {
    const raw = 'disk full https://user:pass@example.test/x Authorization: Bearer abc.def token="quoted secret" NAX_TELEGRAM_TOKEN=123:bot-secret ambient-secret';
    const clean = sanitizeDiagnostic(raw, { NAX_TELEGRAM_TOKEN: '123:bot-secret', API_KEY: 'ambient-secret' });
    expect(clean).toContain('disk full');
    expect(clean).toContain('example.test/x');
    for (const secret of ['user:pass', 'abc.def', 'quoted secret', '123:bot-secret', 'ambient-secret']) expect(clean).not.toContain(secret);
    expect(sanitizeDiagnostic('x'.repeat(10_000))).toHaveLength(800);
  });

  test('reads only the last non-empty lines, strips ANSI escapes, and tolerates missing or unreadable files', async () => {
    const dir = await tmp.make('diagnostic');
    const file = join(dir, 'nax.stderr');
    await writeFile(file, `${'old output\n'.repeat(5_000)}\nline1\nline2\nline3\nline4\nline5\n\u001b[31mplugin init failed\u001b[0m\n\n`);
    const tail = await readDiagnosticTail(file);
    expect(tail).toBe('line2\nline3\nline4\nline5\nplugin init failed');
    expect(await readDiagnosticTail(join(dir, 'missing'))).toBeNull();
    expect(await readDiagnosticTail(dir)).toBeNull();
    await writeFile(file, '\n \n');
    expect(await readDiagnosticTail(file)).toBeNull();
  });
});
