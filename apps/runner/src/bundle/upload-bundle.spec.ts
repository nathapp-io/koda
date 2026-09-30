import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryLogger } from '../logger';
import { NetworkError } from '../sync/http';
import type { BundleFile } from './build-bundle';
import { LARGE_BUNDLE_BYTES, classifyConflict, uploadWithRetry, type UploadDeps } from './upload-bundle';

const file = (sha: string): BundleFile => ({ path: `/j/${sha}.tar.gz`, size: 10, sha256: sha });
type Step = number | Error | { status: number; message: string };
const BIG = 200 * 1024 * 1024;
let script: Step[];
let uploads: BundleFile[];
let rebuilds: number;
let sleeps: number[];
const deps = (): UploadDeps => ({
  upload: async ({ file: f }) => {
    uploads.push(f);
    const step = script.shift();
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'number' ? { status: step } : step;
  },
  rebuild: async () => { rebuilds += 1; return file(`rebuilt${rebuilds}`); },
  sleep: async (ms) => { sleeps.push(ms); },
  log: createMemoryLogger(),
});
beforeEach(() => { script = []; uploads = []; rebuilds = 0; sleeps = []; });

describe('uploadWithRetry (design §2 step 9)', () => {
  test('201 is ok on the first attempt', async () => {
    script.push(201);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'ok' });
    expect(sleeps).toEqual([]);
  });
  test('network errors and 5xx retry with backoff, three attempts in all', async () => {
    script.push(new NetworkError('reset'), 503, 201);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'ok' });
    expect(sleeps).toEqual([1000, 3000]);
    script.push(500, 500, 500);
    expect((await uploadWithRetry(deps(), 'j', 3, file('a'))).kind).toBe('failed');
    expect(uploads).toHaveLength(6);
  });
  test('413 is too-large and is not retried', async () => {
    script.push(413);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'too-large' });
    expect(uploads).toHaveLength(1);
  });
  test('a 409 is classified by its message and never retried (D60): lease lost is stale, a wrong job state is a state-conflict', async () => {
    script.push({ status: 409, message: "This runner does not hold the job's current lease" });
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'stale' });
    script.push({ status: 409, message: 'The job is ASSIGNED; this action is not allowed' });
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'state-conflict', detail: 'The job is ASSIGNED; this action is not allowed' });
    script.push({ status: 409, message: 'The job is COMPLETED; this action is not allowed' });
    expect((await uploadWithRetry(deps(), 'j', 3, file('a'))).kind).toBe('state-conflict');
    expect(uploads).toHaveLength(3);
    expect(sleeps).toEqual([]);
  });
  test('a 409 with no or an unrecognised message is stale: park and wait for ABANDON, the safe default', async () => {
    script.push(409);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'stale' });
    script.push({ status: 409, message: 'Something else entirely' });
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'stale' });
    expect(classifyConflict(undefined)).toBe('stale');
    expect(classifyConflict('The job is RUNNING; this action is not allowed')).toBe('state-conflict');
  });
  test('three network failures on a bundle over 100 MiB are too-large; on a small bundle, or with 5xx, they are a failed upload (D68)', async () => {
    script.push(new NetworkError('reset'), new NetworkError('reset'), new NetworkError('reset'));
    expect(await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).toEqual({ kind: 'too-large' });
    expect(BIG).toBeGreaterThan(LARGE_BUNDLE_BYTES);
    script.push(new NetworkError('reset'), new NetworkError('reset'), new NetworkError('reset'));
    expect((await uploadWithRetry(deps(), 'j', 3, file('small'))).kind).toBe('failed');
    script.push(500, 500, 500);
    expect((await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).kind).toBe('failed');
    script.push(new NetworkError('reset'), 503, new NetworkError('reset'));
    expect((await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).kind).toBe('failed');
  });
  test('BUG-6: NetworkError and 5xx are counted separately; only NetworkError exhaustion on a large bundle becomes too-large', async () => {
    script.push(new NetworkError('reset'), new NetworkError('reset'), new NetworkError('reset'));
    expect(await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).toEqual({ kind: 'too-large' });
    script.push(new NetworkError('reset'), new NetworkError('reset'), new NetworkError('reset'));
    expect((await uploadWithRetry(deps(), 'j', 3, file('small'))).kind).toBe('failed');
    script.push(500, 500, 500);
    expect((await uploadWithRetry(deps(), 'j', 3, { ...file('big'), size: BIG })).kind).toBe('failed');
  });
  test('422 rebuilds the archive once and retries it without spending an attempt; a second 422 fails', async () => {
    script.push(422, 500, 201);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'ok' });
    expect(rebuilds).toBe(1);
    expect(uploads.map((u) => u.sha256)).toEqual(['a', 'rebuilt1', 'rebuilt1']);
    script.push(422, 422);
    rebuilds = 0;
    expect((await uploadWithRetry(deps(), 'j', 3, file('a'))).kind).toBe('failed');
    expect(rebuilds).toBe(1);
  });
  test.each([400, 401, 403, 415])('%d fails at once with the status', async (status) => {
    script.push(status);
    expect(await uploadWithRetry(deps(), 'j', 3, file('a'))).toEqual({ kind: 'failed', detail: `HTTP ${status}` });
    expect(uploads).toHaveLength(1);
  });
  test('a rebuild that throws fails the upload, not the daemon', async () => {
    script.push(422);
    const d = { ...deps(), rebuild: async () => { throw new Error('disk full'); } };
    expect(await uploadWithRetry(d, 'j', 3, file('a'))).toEqual({ kind: 'failed', detail: 'rebuild failed: disk full' });
  });
});
