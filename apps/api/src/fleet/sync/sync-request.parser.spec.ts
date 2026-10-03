import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseSyncRequest } from './sync-request.parser';

const base = { protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 1, jobs: [], commandAcks: [], tokenRequests: [] };
const ev = (seq: number, type = 'log', payload: unknown = { stream: 'run', text: 'x' }) => ({ seq, type, payload });

describe('parseSyncRequest (spec §3.2)', () => {
  it('accepts a full request and defaults missing lists', () => {
    const parsed = parseSyncRequest({
      ...base, jobs: [{ jobId: 'j1', leaseEpoch: 2, events: [ev(1)] }],
      commandAcks: [{ commandId: 'c1', leaseEpoch: 2, result: 'ok' }], tokenRequests: [{ jobId: 'j1', leaseEpoch: 2 }],
    });
    expect(parsed.jobs[0].events[0].seq).toBe(1);
    expect(parseSyncRequest({ protocolVersion: 1, bootId: 'b', daemonVersion: 'd', freeSlots: 0 })).toEqual(
      expect.objectContaining({ jobs: [], commandAcks: [], tokenRequests: [] }),
    );
  });

  it.each([
    ['not an object', 'x'],
    ['negative freeSlots', { ...base, freeSlots: -1 }],
    ['65 free slots', { ...base, freeSlots: 65 }],
    ['empty bootId', { ...base, bootId: '' }],
    ['seq 0', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(0)] }] }],
    ['duplicate seq in one report', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1), ev(1)] }] }],
    ['the same job twice', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [] }, { jobId: 'j', leaseEpoch: 1, events: [] }] }],
    ['an unknown event type', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'shell')] }] }],
    ['a payload that is not an object', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'log', 'text')] }] }],
    ['a payload over 16 KiB', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'log', { text: 'x'.repeat(17_000) })] }] }],
    ['501 events', { ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: Array.from({ length: 501 }, (_, i) => ev(i + 1)) }] }],
    ['an ack result of maybe', { ...base, commandAcks: [{ commandId: 'c', leaseEpoch: 1, result: 'maybe' }] }],
    ['a fractional lease epoch', { ...base, tokenRequests: [{ jobId: 'j', leaseEpoch: 1.5 }] }],
    ['a 65-character job id', { ...base, tokenRequests: [{ jobId: 'j'.repeat(65), leaseEpoch: 1 }] }],
    ['a NUL in the boot id', { ...base, bootId: 'boot\u0000' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSyncRequest(raw)).toThrow(ValidationAppException);
  });

  it('replaces NUL in event payload strings and keys instead of failing the request (review M2)', () => {
    const parsed = parseSyncRequest({ ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'snapshot', { resultBranch: 'a\u0000b', ['k\u0000']: ['x\u0000'] })] }] });
    expect(parsed.jobs[0].events[0].payload).toEqual({ resultBranch: 'a\uFFFDb', ['k\uFFFD']: ['x\uFFFD'] });
  });

  it('accepts an approval_request event with an object payload', () => {
    const payload = {
      naxAskId: 'ask-1f2e3d4c', deadlineAt: '2026-10-04T10:10:00.000Z', command: 'bun run test', commandTruncated: false,
      maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule',
      options: ['allow', 'allow-remember', 'deny'],
    };
    const parsed = parseSyncRequest({ ...base, jobs: [{ jobId: 'j', leaseEpoch: 1, events: [ev(1, 'approval_request', payload)] }] });
    expect(parsed.jobs[0].events[0]).toEqual({ seq: 1, type: 'approval_request', payload });
  });
});
