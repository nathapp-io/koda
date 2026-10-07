import { describe, expect, test } from 'bun:test';
import { createMemoryLogger } from '../logger';
import { NetworkError, ServerError } from '../sync/http';
import { fakeTime } from '../../test/helpers/fake-time';
import { CONFIG_FETCH_BACKOFF_MS, fetchConfigEdit, type ConfigEditSource } from './config-edit-fetch';

const good = { mode: 'drift', edits: [], prTitle: null, prBody: null, baseSha: 'a'.repeat(40) };
const run = (source: ConfigEditSource | undefined, halted = () => false) => {
  const time = fakeTime();
  return { time, result: fetchConfigEdit({ source, jobId: 'j1', leaseEpoch: 2, command: 'CONFIG_DRIFT', sleep: time.sleep, isHalted: halted, log: createMemoryLogger() }) };
};

describe('fetchConfigEdit (S3 §3)', () => {
  test('returns the validated payload', async () => {
    const seen: Array<[string, number]> = [];
    expect(await run({ fetch: async (id, epoch) => { seen.push([id, epoch]); return good; } }).result).toEqual({ kind: 'ok', payload: good as never });
    expect(seen).toEqual([['j1', 2]]);
  });
  test('a 409 is stale: the server has fenced the lease and sends ABANDON', async () => {
    expect(await run({ fetch: async () => { throw new ServerError(409, 'stale lease', null); } }).result).toEqual({ kind: 'stale' });
  });
  test('another 4xx fails at once; an invalid payload fails', async () => {
    expect(await run({ fetch: async () => { throw new ServerError(404, 'no', null); } }).result).toEqual({ kind: 'failed', reason: 'config edit fetch refused (404)' });
    expect(await run({ fetch: async () => ({ ...good, mode: 'edit' }) }).result).toEqual({ kind: 'failed', reason: 'invalid config edit payload' });
  });
  test('network errors and 5xx are retried with the back-off, then fail', async () => {
    let calls = 0;
    const r = run({ fetch: async () => { calls += 1; throw calls === 1 ? new NetworkError('down') : new ServerError(503, 'busy', null); } });
    expect(await r.result).toEqual({ kind: 'failed', reason: 'config edit fetch failed' });
    expect(calls).toBe(CONFIG_FETCH_BACKOFF_MS.length + 1);
    expect(r.time.nowMs() - Date.parse('2026-10-01T00:00:00.000Z')).toBe(CONFIG_FETCH_BACKOFF_MS.reduce((a, b) => a + b, 0));
  });
  test('a retry recovers', async () => {
    let calls = 0;
    expect(await run({ fetch: async () => { calls += 1; if (calls === 1) throw new NetworkError('blip'); return good; } }).result).toMatchObject({ kind: 'ok' });
  });
  test('a halt during the back-off stops without a verdict', async () => {
    let halted = false;
    const r = run({ fetch: async () => { halted = true; throw new NetworkError('down'); } }, () => halted);
    expect(await r.result).toEqual({ kind: 'stale' });
  });
  test('a runner built without a source fails the job', async () => {
    expect(await run(undefined).result).toEqual({ kind: 'failed', reason: 'config jobs are not wired in this runner' });
  });
});
