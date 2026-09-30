import { describe, expect, test } from 'bun:test';
import { createLogger, createMemoryLogger, redact } from './logger';

describe('redact', () => {
  test('replaces secret-looking keys at any depth and leaves the rest', () => {
    expect(redact({ apiKey: 'kr_x', nested: { Authorization: 'Bearer y', ok: 1 }, list: [{ token: 't' }], name: 'n' })).toEqual({
      apiKey: '[redacted]', nested: { Authorization: '[redacted]', ok: 1 }, list: [{ token: '[redacted]' }], name: 'n',
    });
  });
  test('STYLE-1: a camelCase lower→upper case change is a boundary too, so apiKey stays redacted while monkey/monkeyCount do not', () => {
    expect(redact({ monkeyCount: 5, monkey: 1, tokenize: true, xKeyx: 'k' })).toEqual({ monkeyCount: 5, monkey: 1, tokenize: true, xKeyx: 'k' });
    const api = redact({ apiKey: 'sk-1', accessToken: 't' }) as Record<string, unknown>;
    expect(api['apiKey']).toBe('[redacted]');
    expect(api['accessToken']).toBe('[redacted]');
  });
  test('bounds recursion instead of overflowing on a cycle', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe('createLogger', () => {
  test('writes one JSON object per line with level, message, time and redacted fields', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), () => new Date('2026-10-01T00:00:00.000Z'));
    log.warn('sync failed', { status: 500, apiKey: 'kr_secret' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ ts: '2026-10-01T00:00:00.000Z', level: 'warn', msg: 'sync failed', status: 500, apiKey: '[redacted]' });
    expect(lines[0]).not.toContain('kr_secret');
  });
  test('memory logger records what it was given', () => {
    const log = createMemoryLogger();
    log.info('a', { x: 1 });
    log.error('b');
    expect(log.lines).toEqual([{ level: 'info', message: 'a', fields: { x: 1 } }, { level: 'error', message: 'b', fields: {} }]);
  });
});
