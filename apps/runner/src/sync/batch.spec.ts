import { beforeEach, describe, expect, test } from 'bun:test';
import { FLEET_PROTOCOL_VERSION } from '@nathapp/fleet-protocol';
import type { AssignPayload } from '@nathapp/fleet-protocol';
import { Journal } from '../journal/journal';
import { ACK_DETAIL_MAX, FULL_SCALE, MAX_BODY_BYTES, SYNC_LIMITS, buildSyncRequest, byteLength, clampAck, doubleScale, halveScale } from './batch';

const assign = (jobId: string): AssignPayload => ({
  jobId, command: 'RUN', repo: { provider: 'github', owner: 'a', name: 'b', defaultBranch: 'main', cloneUrl: 'https://x/a/b.git' },
  ref: 'main', feature: 'f', planFrom: null, profiles: [], maxCostUsd: '1', bashMode: 'raw', approvalTimeoutSec: 600, gitIdentity: { name: 'n', email: 'e' },
});
let j: Journal;
beforeEach(() => { j = Journal.open(':memory:'); });
const add = (jobId: string, leaseEpoch = 1) => j.insertJob({ assign: assign(jobId), leaseEpoch, repoKey: 'a/b', jobDir: `/w/${jobId}` });
const build = (over: Partial<Parameters<typeof buildSyncRequest>[0]> = {}) =>
  buildSyncRequest({ journal: j, bootId: 'boot', daemonVersion: '0.1.0', freeSlots: 1, acks: [], scale: FULL_SCALE, ...over });

describe('scale', () => {
  test('halves down to {1,1} and then reports null', () => {
    const seen: string[] = [];
    for (let s: ReturnType<typeof halveScale> = FULL_SCALE; s; s = halveScale(s)) seen.push(`${s.jobs}/${s.events}`);
    expect(seen).toEqual(['64/500', '32/250', '16/125', '8/62', '4/31', '2/15', '1/7', '1/3', '1/1']);
  });
  test('doubles back up and never beyond the limits', () => {
    expect(doubleScale({ jobs: 1, events: 1 })).toEqual({ jobs: 2, events: 2 });
    expect(doubleScale({ jobs: 40, events: 400 })).toEqual(FULL_SCALE);
  });
});

describe('clampAck (D59)', () => {
  const ack = (detail?: string) => ({ commandId: 'c', leaseEpoch: 1, result: 'rejected' as const, ...(detail !== undefined ? { detail } : {}) });
  test('leaves a short detail, and an absent one, alone', () => {
    expect(clampAck(ack('short'))).toEqual(ack('short'));
    expect(clampAck(ack())).toEqual(ack());
  });
  test('cuts a long detail to 200 characters', () => {
    expect(clampAck(ack('x'.repeat(600))).detail).toHaveLength(ACK_DETAIL_MAX);
  });
  test('never leaves half a surrogate pair, and replaces NUL (the server rejects it)', () => {
    const cut = clampAck(ack(`${'a'.repeat(199)}\u{1F600}tail`)).detail ?? '';
    expect(cut).toBe('a'.repeat(199));
    expect(clampAck(ack('a\u0000b')).detail).toBe('a�b');
  });
});

describe('buildSyncRequest', () => {
  test('reports pending events per job with their epoch, capped by the scale', () => {
    add('a');
    add('b');
    for (let i = 0; i < 5; i += 1) j.appendEvent('a', 1, 'log', { stream: 'run', text: `l${i}` });
    j.appendEvent('b', 1, 'lifecycle', { level: 'info', message: 'm' });
    const req = build({ scale: { jobs: 1, events: 3 } });
    expect(req.jobs).toHaveLength(1);
    expect(req.jobs[0]).toMatchObject({ jobId: 'a', leaseEpoch: 1 });
    expect(req.jobs[0].events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(req).toMatchObject({ protocolVersion: FLEET_PROTOCOL_VERSION, bootId: 'boot', daemonVersion: '0.1.0', freeSlots: 1, commandAcks: [], tokenRequests: [] });
  });
  test('jobs with nothing pending are not reported', () => {
    add('a');
    expect(build().jobs).toEqual([]);
  });
  test('caps acks at 256, clamps freeSlots to 0..64, and carries capabilities when given', () => {
    const acks = Array.from({ length: 300 }, (_, i) => ({ commandId: `c${i}`, leaseEpoch: 1, result: 'ok' as const }));
    expect(build({ acks }).commandAcks).toHaveLength(SYNC_LIMITS.acks);
    expect(build({ freeSlots: -3 }).freeSlots).toBe(0);
    expect(build({ freeSlots: 500 }).freeSlots).toBe(64);
    expect(build({ freeSlots: 1.9 }).freeSlots).toBe(1);
    const caps = { nax: { version: '1', protocols: ['native' as const] }, sandbox: { available: true, probedAt: 'x' }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: true }, executors: ['host' as const] };
    expect(build({ capabilities: caps }).capabilities).toEqual(caps);
    expect(build().capabilities).toBeUndefined();
  });
  test('reports ONE entry per jobId, the highest pending epoch first; the older epoch waits (D56)', () => {
    // The server's parseSyncRequest answers 400 "duplicate job" for two entries with one jobId.
    add('a', 1);
    add('a', 2);
    add('b', 1);
    j.appendEvent('a', 1, 'log', { stream: 'run', text: 'old' });
    j.appendEvent('a', 2, 'log', { stream: 'run', text: 'new' });
    j.appendEvent('b', 1, 'log', { stream: 'run', text: 'b' });
    const first = build();
    expect(first.jobs.map((job) => `${job.jobId}@${job.leaseEpoch}`)).toEqual(['a@2', 'b@1']);
    expect(new Set(first.jobs.map((job) => job.jobId)).size).toBe(first.jobs.length);
    j.ackThrough('a', 2, 1);
    expect(build().jobs.map((job) => `${job.jobId}@${job.leaseEpoch}`)).toEqual(['a@1', 'b@1']);
  });
  test('the job cap counts distinct jobs, not (job, epoch) pairs', () => {
    add('a', 1);
    add('a', 2);
    add('b', 1);
    for (const [id, epoch] of [['a', 1], ['a', 2], ['b', 1]] as const) j.appendEvent(id, epoch, 'log', { stream: 'run', text: 'x' });
    expect(build({ scale: { jobs: 2, events: 5 } }).jobs.map((job) => job.jobId)).toEqual(['a', 'b']);
  });
  test('stays under the body budget, and under the real 1 MiB cap, with 64 jobs of large events (D26)', () => {
    for (let i = 0; i < 64; i += 1) {
      add(`job${i}`);
      for (let e = 0; e < 60; e += 1) j.appendEvent(`job${i}`, 1, 'log', { stream: 'run', text: 'x'.repeat(7_000) });
    }
    const req = build();
    expect(byteLength(req)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(byteLength(req)).toBeLessThanOrEqual(1_048_576); // the server's cap, whatever the wrapper estimate
    expect(req.jobs.flatMap((job) => job.events).length).toBeGreaterThan(50);
    for (const job of req.jobs) expect(job.events.length).toBeLessThanOrEqual(SYNC_LIMITS.eventsPerJob);
  });
  test('always includes at least the first event, however large the backlog', () => {
    add('a');
    j.appendEvent('a', 1, 'log', { stream: 'run', text: 'y'.repeat(8_000) });
    expect(build().jobs[0].events).toHaveLength(1);
  });
  test('a runner from S2a 1b on speaks protocol v3: it streams logs and sends no log sync events (spec R1, plan D328)', () => {
    expect(FLEET_PROTOCOL_VERSION).toBe(3);
  });
});

describe('token requests (design §3.1)', () => {
  test('are carried as given, capped at the sync limit of 64', () => {
    const journal = Journal.open(':memory:');
    const tokenRequests = Array.from({ length: 70 }, (_, i) => ({ jobId: `j${i}`, leaseEpoch: 1 }));
    const request = buildSyncRequest({ journal, bootId: 'b', daemonVersion: 'v', freeSlots: 1, acks: [], scale: FULL_SCALE, tokenRequests });
    expect(request.tokenRequests).toHaveLength(SYNC_LIMITS.tokenRequests);
    expect(request.tokenRequests[0]).toEqual({ jobId: 'j0', leaseEpoch: 1 });
  });
  test('are empty when none are given', () => {
    const request = buildSyncRequest({ journal: Journal.open(':memory:'), bootId: 'b', daemonVersion: 'v', freeSlots: 1, acks: [], scale: FULL_SCALE });
    expect(request.tokenRequests).toEqual([]);
  });
});
