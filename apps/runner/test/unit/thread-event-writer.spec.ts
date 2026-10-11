import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets, type SessionEvent } from '@nathapp/nax-agent';

const writerModule = await import('../../src/thread/thread-event-writer').catch(() => null);
const testRoot = join(import.meta.dir, `.thread-event-writer-${crypto.randomUUID()}`);
const now = () => new Date('2026-01-02T03:04:05.000Z');
const logs = { wake: (_jobId: string, _leaseEpoch: number) => undefined };

beforeAll(async () => mkdir(testRoot, { recursive: true }));
afterAll(async () => rm(testRoot, { recursive: true, force: true }));

async function makeWriter(options: { path?: string; streamMaxBytes?: number; wakeGapMs?: number; onCap?: () => void } = {}) {
  const path = options.path ?? join(testRoot, crypto.randomUUID());
  if (!writerModule) {
    expect(writerModule).not.toBeNull();
    return null;
  }
  const writer = new writerModule.ThreadEventWriter({
    path,
    jobId: 'job-1',
    leaseEpoch: 1,
    logs,
    wakeGapMs: options.wakeGapMs ?? 10,
    now,
    sleep: async () => undefined,
    streamMaxBytes: options.streamMaxBytes,
    onCap: options.onCap ?? (() => undefined),
    onWarn: () => undefined,
  });
  return { path, writer };
}

const base = { sessionId: 'session-1', turnId: 'turn-1', at: '2026-01-02T03:04:05.000Z' };
const readLines = async (path: string): Promise<Record<string, unknown>[]> => {
  const content = await readFile(path, 'utf8');
  return content.trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
};
const textEvent = (text: string, round = 1): SessionEvent => ({ type: 'text_delta', ...base, round, text });

describe('ThreadEventWriter (US-007)', () => {
  test('US-007 AC-1: redacts a secret split across deltas when the round is finalized', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const full = `key: sk-ant-api03-${'a'.repeat(80)}`;
    const split = Math.floor(full.length / 2);
    setup.writer.event(textEvent(full.slice(0, split)));
    setup.writer.event(textEvent(full.slice(split)));
    setup.writer.event({ type: 'turn_end', ...base, round: 1, output: '' });
    const lines = await readLines(setup.path);
    expect(lines.filter((line) => line.type === 'text_delta').map((line) => line.text).join('')).toBe(redactSecrets(full));
  });

  test('US-007 AC-2: emits a held long delta as a bounded whitespace-terminated prefix before the next event', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const text = Array.from({ length: 100 }, (_, index) => String(index).padEnd(9, 'x')).join(' ').slice(0, 1000);
    setup.writer.event(textEvent(text));
    setup.writer.event({ type: 'thinking_delta', ...base, round: 1, text: 'next' });
    const lines = await readLines(setup.path);
    const joined = lines.filter((line) => line.type === 'text_delta').map((line) => line.text).join('');
    expect(joined.length <= 744 && text.startsWith(joined) && joined.endsWith(' ')).toBe(true);
  });

  test('US-007 AC-3: flushes pending text before a later tool call line', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    setup.writer.event(textEvent('x'.repeat(100)));
    setup.writer.event({ type: 'tool_call', ...base, round: 1, toolCallId: 'call-1', name: 'lookup', input: {} });
    const lines = await readLines(setup.path);
    expect(lines.findIndex((line) => line.type === 'text_delta' && line.text === 'x'.repeat(100)) < lines.findIndex((line) => line.type === 'tool_call')).toBe(true);
  });

  test('US-007 AC-4: discards the pending text for a reset round', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    setup.writer.event(textEvent('z'.repeat(100)));
    setup.writer.event({ type: 'stream_reset', ...base, round: 1 });
    const lines = await readLines(setup.path);
    expect(lines.some((line) => line.text === 'z'.repeat(100))).toBe(false);
  });

  test('US-007 AC-5: redacts turn output as a whole', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const output = `secret sk-ant-api03-${'b'.repeat(80)}`;
    setup.writer.event({ type: 'turn_end', ...base, round: 1, output });
    expect((await readLines(setup.path)).find((line) => line.type === 'turn_end')?.output).toBe(redactSecrets(output));
  });

  test('US-007 AC-6: redacts the turn error message as a whole', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const message = `failed sk-ant-api03-${'c'.repeat(80)}`;
    setup.writer.event({ type: 'turn_end', ...base, round: 1, output: '', error: { message } });
    expect(((await readLines(setup.path)).find((line) => line.type === 'turn_end')?.error as { message: string }).message).toBe(redactSecrets(message));
  });

  test('US-007 AC-7: redacts a thinking delta', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const text = `thinking sk-ant-api03-${'d'.repeat(80)}`;
    setup.writer.event({ type: 'thinking_delta', ...base, round: 1, text });
    expect((await readLines(setup.path)).find((line) => line.type === 'thinking_delta')?.text).toBe(redactSecrets(text));
  });

  test('US-007 AC-8: keeps every multibyte JSONL line within the UTF-8 line limit', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const text = `${'é'.repeat(4)} `.repeat(40_000);
    setup.writer.event(textEvent(text));
    setup.writer.event({ type: 'turn_end', ...base, round: 1, output: '' });
    const content = await readFile(setup.path);
    expect(content.toString('utf8').split('\n').filter(Boolean).every((line) => Buffer.byteLength(`${line}\n`, 'utf8') <= 65_536)).toBe(true);
  });

  test('US-007 AC-9: preserves all characters across split text lines', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    const text = `${'wordword '.repeat(24_999)}wordword`;
    setup.writer.event(textEvent(text));
    setup.writer.event({ type: 'turn_end', ...base, round: 1, output: '' });
    expect((await readLines(setup.path)).filter((line) => line.type === 'text_delta').map((line) => line.text).join('')).toBe(text);
  });

  test('US-007 AC-10: replaces an oversized turn output with the truncated marker', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    setup.writer.event({ type: 'turn_end', ...base, round: 1, output: 'o'.repeat(100_000) });
    const endLines = (await readLines(setup.path)).filter((line) => line.type === 'turn_end');
    expect(endLines).toHaveLength(1);
    expect(endLines[0]).toMatchObject({ output: '', outputTruncated: true });
  });

  test('US-007 AC-11: writes the session-start runner line with its timestamp and backend', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    setup.writer.started({ resumed: false, backend: { kind: 'native', model: 'm/x' }, skillShas: ['<sha>'] });
    expect((await readLines(setup.path))[0]).toEqual({ type: 'session_started', at: now().toISOString(), resumed: false, backend: { kind: 'native', model: 'm/x' }, skillShas: ['<sha>'] });
  });

  test('US-007 AC-12: writes the consumed input runner line', async () => {
    const setup = await makeWriter();
    if (!setup) return;
    setup.writer.inputConsumed('msg1');
    expect((await readLines(setup.path))[0]).toEqual({ type: 'input_consumed', at: now().toISOString(), messageId: 'msg1' });
  });

  test('US-007 AC-13: coalesces wakes and issues one trailing wake after the gap', async () => {
    let time = 0;
    const wakes: number[] = [];
    const path = join(testRoot, crypto.randomUUID());
    if (!writerModule) {
      expect(writerModule).not.toBeNull();
      return;
    }
    const writer = new writerModule.ThreadEventWriter({ path, jobId: 'job-1', leaseEpoch: 1, logs: { wake: () => wakes.push(time) }, wakeGapMs: 10, now: () => new Date(time), sleep: async (ms: number) => { time += ms; }, onCap: () => undefined, onWarn: () => undefined });
    for (let i = 0; i < 10; i++) writer.event({ type: 'thinking_delta', ...base, round: 1, text: 'x' });
    time = 11;
    await Bun.sleep(0);
    expect(wakes).toHaveLength(2);
  });

  test('US-007 AC-14: caps session lines once when existing bytes have crossed the reserve threshold', async () => {
    const path = join(testRoot, crypto.randomUUID());
    await writeFile(path, 'x'.repeat(4200), { mode: 0o600 });
    let caps = 0;
    const setup = await makeWriter({ path, streamMaxBytes: 8192, onCap: () => { caps++; } });
    if (!setup) return;
    setup.writer.event({ type: 'thinking_delta', ...base, round: 1, text: 'a'.repeat(100) });
    setup.writer.event({ type: 'thinking_delta', ...base, round: 1, text: 'b'.repeat(100) });
    expect({ bytes: (await readFile(setup.path)).byteLength, caps }).toEqual({ bytes: 4200, caps: 1 });
  });

  test('US-007 AC-15: always writes a runner close line after the session cap', async () => {
    const path = join(testRoot, crypto.randomUUID());
    await writeFile(path, 'x'.repeat(4200), { mode: 0o600 });
    const setup = await makeWriter({ path, streamMaxBytes: 8192 });
    if (!setup) return;
    setup.writer.closed('stream_cap');
    const appended = (await readFile(setup.path, 'utf8')).slice(4200).trim();
    expect(JSON.parse(appended)).toMatchObject({ type: 'session_closed', reason: 'stream_cap' });
  });
});
