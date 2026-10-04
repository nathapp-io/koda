import { describe, expect, test } from 'bun:test';
import { classifyAnswer } from './answer';

describe('classifyAnswer (spec §2.4 table, plan D323)', () => {
  test('2xx outcomes', () => {
    expect(classifyAnswer({ status: 200, outcome: 'appended', size: 10 })).toEqual({ kind: 'ack', size: 10 });
    expect(classifyAnswer({ status: 200, outcome: 'duplicate', size: 10 })).toEqual({ kind: 'ack', size: 10 });
    expect(classifyAnswer({ status: 200, outcome: 'offset', size: 4 })).toEqual({ kind: 'ack', size: 4 });
    expect(classifyAnswer({ status: 200, outcome: 'complete', size: 12 })).toEqual({ kind: 'done', size: 12 });
    expect(classifyAnswer({ status: 200, outcome: 'stream_cap', size: 99 })).toEqual({ kind: 'cap', size: 99 });
    expect(classifyAnswer({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 300 })).toEqual({ kind: 'pause', ms: 300 });
    expect(classifyAnswer({ status: 200, outcome: 'rate_limited', size: -1 })).toEqual({ kind: 'pause', ms: 1_000 });
    expect(classifyAnswer({ status: 200, outcome: 'rate_limited', size: -1, retryAfterMs: 3_600_000 })).toEqual({ kind: 'pause', ms: 60_000 });
  });
  test('a 2xx without a usable outcome and size backs off', () => {
    expect(classifyAnswer({ status: 200 })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
    expect(classifyAnswer({ status: 200, outcome: 'appended' })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
    expect(classifyAnswer({ status: 200, outcome: 'appended', size: 1.5 })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
    expect(classifyAnswer({ status: 200, outcome: 'appended', size: -1 })).toEqual({ kind: 'backoff', detail: 'malformed 2xx answer' });
  });
  test('401, 404 and 409 stop the whole job', () => {
    for (const status of [401, 404, 409]) expect(classifyAnswer({ status })).toEqual({ kind: 'stop-job', status });
  });
  test('408, 422, 429 and every 5xx back off', () => {
    for (const status of [408, 422, 429, 500, 502, 507]) expect(classifyAnswer({ status })).toEqual({ kind: 'backoff', detail: `HTTP ${status}` });
  });
  test('any other status fails only that stream', () => {
    for (const status of [400, 403, 413, 426, 302]) expect(classifyAnswer({ status })).toEqual({ kind: 'fail-stream', status });
  });
});
