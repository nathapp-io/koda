import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut, ThreadAssign } from '@nathapp/fleet-protocol';
import { assignFor } from '../../test/helpers/assign';
import { parseAssign } from './assign-parser';

const cmd = (payload: unknown, over: Partial<FleetCommandOut> = {}): FleetCommandOut => ({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: payload as never, ...over });

function validThread(): ThreadAssign {
  return {
    threadId: 't1',
    action: 'SESSION',
    feature: 'brainstorm-x',
    resume: false,
    instructions: 'be helpful',
    backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
    skills: [
      {
        sourceId: 's1',
        owner: 'acme',
        repo: 'skills',
        sha: 'a'.repeat(40),
        skills: [{ name: 'spec-writing', dir: 'spec-writing', description: 'writes specs' }],
      },
    ],
    initialMessage: { messageId: 'm1', text: 'hi' },
  };
}

function threadFixture(overThread: Partial<ThreadAssign> & Record<string, unknown> = {}, overAssign: Record<string, unknown> = {}) {
  const thread = { ...validThread(), ...overThread } as ThreadAssign;
  return { assign: assignFor('THREAD', { feature: 'thread-t1', thread, ...overAssign } as never), thread };
}

describe('parseAssign THREAD (US-001)', () => {
  test('US-001 AC-1: valid THREAD fixture returns assign.thread deep-equal to the thread block', () => {
    const { assign, thread } = threadFixture();
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).toEqual(thread);
  });

  test('US-001 AC-2: fixture without thread returns invalid thread', () => {
    const { thread: _omit, ...withoutThread } = assignFor('THREAD', { feature: 'thread-t1' }) as unknown as Record<string, unknown>;
    void _omit;
    expect(parseAssign(cmd(withoutThread))).toEqual({ ok: false, detail: 'invalid thread' });
  });

  test('US-001 AC-3: RUN carrying the thread block returns invalid thread', () => {
    const run = assignFor('RUN', { thread: validThread() } as never);
    expect(parseAssign(cmd(run))).toEqual({ ok: false, detail: 'invalid thread' });
  });

  test('US-001 AC-4: fixture with profiles [fast] returns invalid profiles', () => {
    const { assign } = threadFixture({}, { profiles: ['fast'] });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid profiles' });
  });

  test('US-001 AC-5: fixture with bashMode gated returns invalid bashMode', () => {
    const { assign } = threadFixture({}, { bashMode: 'gated' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });

  test('US-001 AC-6: fixture with threadId ../t1 returns invalid threadId', () => {
    const { assign } = threadFixture({ threadId: '../t1' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid threadId' });
  });

  test('US-001 AC-7: fixture with an unknown action REVIEW returns invalid thread action', () => {
    const { assign } = threadFixture({ action: 'REVIEW' as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread action' });
  });

  test('US-001 AC-10: fixture with action PUBLISH and initialMessage null returns assign.thread with action PUBLISH', () => {
    const { assign } = threadFixture({ action: 'PUBLISH', initialMessage: null as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.action).toBe('PUBLISH');
  });

  test('US-001 AC-11: fixture with action DISCARD and initialMessage null returns assign.thread with action DISCARD', () => {
    const { assign } = threadFixture({ action: 'DISCARD', initialMessage: null as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.action).toBe('DISCARD');
  });

  test('US-001 AC-12: fixture with action PUBLISH and a non-null initialMessage returns invalid initialMessage', () => {
    const { assign } = threadFixture({ action: 'PUBLISH' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });

  test('US-001 AC-12b: fixture with action DISCARD and a non-null initialMessage returns invalid initialMessage', () => {
    const { assign } = threadFixture({ action: 'DISCARD' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });

  test('US-001 AC-14: fixture with thread title "Divide brainstorm" returns assign.thread with that title', () => {
    const { assign } = threadFixture({ title: 'Divide brainstorm' } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.title).toBe('Divide brainstorm');
  });

  test('US-001 AC-14b: fixture without thread title returns assign.thread with no title key', () => {
    const { assign } = threadFixture();
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).not.toHaveProperty('title');
  });

  test('US-001 AC-15: fixture with a 201-character thread title returns invalid thread title', () => {
    const { assign } = threadFixture({ title: 'a'.repeat(201) } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread title' });
  });

  test('US-001 AC-15b: fixture with an empty thread title returns invalid thread title', () => {
    const { assign } = threadFixture({ title: '' } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread title' });
  });

  test('US-001 AC-15c: fixture with a 200-character thread title is accepted', () => {
    const { assign } = threadFixture({ title: 'a'.repeat(200) } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
  });

  test('US-001 AC-15d: fixture with a non-string thread title returns invalid thread title', () => {
    const { assign } = threadFixture({ title: 42 } as never);
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread title' });
  });

  test('US-001 AC-8: fixture with thread feature ../x returns invalid thread feature', () => {
    const { assign } = threadFixture({ feature: '../x' });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid thread feature' });
  });

  test('US-001 AC-9: fixture with native model m/x[high] returns invalid backend', () => {
    const { assign } = threadFixture({ backend: { kind: 'native', model: 'm/x[high]' } as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid backend' });
  });

  test('US-001 AC-10: fixture with acp claude backend returns ok true', () => {
    const { assign } = threadFixture({ backend: { kind: 'acp', agent: 'claude' } as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
  });

  test('US-001 AC-11: fixture with skills none returns invalid skills', () => {
    const { assign } = threadFixture({ skills: 'none' as never });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid skills' });
  });

  test('US-001 AC-12: fixture with 32769 ascii initialMessage text returns invalid initialMessage', () => {
    const { assign } = threadFixture({ initialMessage: { messageId: 'm1', text: 'a'.repeat(32769) } });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });

  test('US-001 AC-13: fixture with initialMessage null returns assign.thread with null initialMessage', () => {
    const { assign } = threadFixture({ initialMessage: null as never });
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread?.initialMessage).toBeNull();
  });

  test('US-001 AC-14: fixture with extra thread key returns assign.thread without extra', () => {
    const base = threadFixture();
    const withExtra = { ...base.thread, extra: 1 } as unknown as ThreadAssign;
    const assign = assignFor('THREAD', { feature: 'thread-t1', thread: withExtra } as never);
    const parsed = parseAssign(cmd(assign));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.thread).not.toHaveProperty('extra');
  });

  test('US-001 AC-15: fixture with 11000 zhong text returns invalid initialMessage', () => {
    const { assign } = threadFixture({ initialMessage: { messageId: 'm1', text: '中'.repeat(11000) } });
    expect(parseAssign(cmd(assign))).toEqual({ ok: false, detail: 'invalid initialMessage' });
  });
});
