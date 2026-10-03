import { beforeEach, describe, expect, test } from 'bun:test';
import type { ApprovalRequestEventPayload } from '@nathapp/fleet-protocol';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { buildAskPayload } from '../approvals/ask-payload';
import { Journal } from '../journal/journal';
import { createMemoryLogger, type MemoryLogger } from '../logger';
import { assignFor } from '../../test/helpers/assign';
import { JobEvents } from './job-events';

let journal: Journal;
let log: MemoryLogger;
let events: JobEvents;
const all = () => journal.pendingEvents('j1', 1, 100);
beforeEach(() => {
  journal = Journal.open(':memory:');
  journal.insertJob({ assign: assignFor(), leaseEpoch: 1, repoKey: 'acme/app', jobDir: '/w/.jobs/j1' });
  log = createMemoryLogger();
  events = new JobEvents(journal, 'j1', 1, log);
});

describe('transition', () => {
  test('a legal transition appends a state event and moves the journal state in one step, with the patch', () => {
    expect(events.transition('RUNNING', undefined, { pid: 7, pgid: 7, branch: 'feat/x' })).toBe(true);
    expect(all()).toMatchObject([{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }]);
    expect(journal.getJob('j1', 1)).toMatchObject({ state: 'RUNNING', pid: 7, pgid: 7, branch: 'feat/x' });
    expect(events.currentState()).toBe('RUNNING');
  });
  test('an illegal transition is refused: no state event, a lifecycle error, state unchanged', () => {
    expect(events.transition('COMPLETED')).toBe(false);
    expect(events.transition('UPLOADING')).toBe(false);
    expect(journal.getJob('j1', 1)?.state).toBe('ASSIGNED');
    expect(all().map((e) => e.type)).toEqual(['lifecycle', 'lifecycle']);
    expect(all()[0].payload).toMatchObject({ level: 'error', message: expect.stringContaining('ASSIGNED -> COMPLETED') });
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
  test('a full RUN path is accepted, a second terminal is not', () => {
    for (const to of ['RUNNING', 'UPLOADING', 'COMPLETED'] as const) expect(events.transition(to)).toBe(true);
    expect(events.transition('FAILED')).toBe(false);
    expect(all().filter((e) => e.type === 'state').map((e) => (e.payload as { to: string }).to)).toEqual(['RUNNING', 'UPLOADING', 'COMPLETED']);
  });
  test('the reason is kept but cut to 500 characters', () => {
    events.transition('FAILED', 'x'.repeat(900));
    expect((all()[0].payload as { reason: string }).reason).toHaveLength(500);
  });
});

describe('payload guards', () => {
  test('lifecycle messages are cut to 2000 characters', () => {
    events.lifecycle('warn', 'm'.repeat(5000));
    expect((all()[0].payload as { message: string }).message).toHaveLength(2000);
  });
  test('an oversize snapshot drops progress so it fits the 16 KiB payload limit', () => {
    events.snapshot({ naxRunId: 'r', progress: { blob: 'x'.repeat(20_000) } as never });
    expect(all()[0].payload).toEqual({ naxRunId: 'r' });
    events.snapshot({ naxRunId: 'r', progress: { total: 3 } });
    expect(all()[1].payload).toEqual({ naxRunId: 'r', progress: { total: 3 } });
  });
  test('D151: a snapshot still too big without progress drops the story list next, and keeps progress when that fits', () => {
    const stories = [{ id: 'US-001', title: 'x'.repeat(20_000), status: 'pending', attempts: 0, dependsOn: [] }];
    events.snapshot({ naxRunId: 'r', progress: { total: 3 }, stories, storiesTruncated: false });
    events.snapshot({ naxRunId: 'r2', progress: { blob: 'x'.repeat(20_000) } as never, stories, storiesTruncated: true });
    const [first, second] = all().map((e) => e.payload);
    expect(first).toEqual({ naxRunId: 'r', progress: { total: 3 } });
    expect(second).toEqual({ naxRunId: 'r2' });
  });
  test('an oversize log line is cut down', () => {
    events.logLine({ stream: 'run', text: 'y'.repeat(20_000) });
    expect((all()[0].payload as { text: string }).text).toHaveLength(4000);
  });
});

describe('a job that is gone (abandoned)', () => {
  test('every call is a quiet no-op', () => {
    journal.abandon('j1', 1);
    expect(events.currentState()).toBeNull();
    expect(events.transition('RUNNING')).toBe(false);
    expect(() => { events.snapshot({ naxRunId: 'r' }); events.lifecycle('info', 'x'); events.logLine({ stream: 'run', text: 'x' }); }).not.toThrow();
    expect(journal.pendingEvents('j1', 1, 10)).toEqual([]);
  });
});

describe('approvalRequest (S1.5 2a)', () => {
  const ASK_PAYLOAD = buildAskPayload(fixtures.a_simple) as ApprovalRequestEventPayload;
  test('approvalRequest appends an approval_request event (and wakes the sync loop through onWrite)', () => {
    let writes = 0;
    journal.onWrite(() => { writes += 1; });
    events.approvalRequest(ASK_PAYLOAD);
    expect(journal.pendingEvents('j1', 1, 1_000).at(-1)).toEqual(expect.objectContaining({ type: 'approval_request', payload: ASK_PAYLOAD }));
    expect(writes).toBeGreaterThan(0);
  });
});
