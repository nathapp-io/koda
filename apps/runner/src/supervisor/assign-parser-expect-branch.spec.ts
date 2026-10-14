import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut } from '@nathapp/fleet-protocol';
import { assignFor } from '../../test/helpers/assign';
import { parseAssign } from './assign-parser';

const cmd = (payload: unknown, over: Partial<FleetCommandOut> = {}): FleetCommandOut => ({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: payload as never, ...over });

describe('parseAssign expectBranch (US-005)', () => {
  test('US-005 AC-1: a PLAN ASSIGN with expectBranch returns an assign whose expectBranch is copied', () => {
    const parsed = parseAssign(cmd({ ...assignFor('PLAN'), expectBranch: 'feat/add-auth' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.expectBranch).toBe('feat/add-auth');
  });

  test('US-005 AC-2: a PLAN ASSIGN without expectBranch returns an assign with no expectBranch key', () => {
    const parsed = parseAssign(cmd(assignFor('PLAN')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign).not.toHaveProperty('expectBranch');
  });

  test('US-005 AC-3: a RUN ASSIGN with expectBranch is rejected with invalid expectBranch', () => {
    expect(parseAssign(cmd({ ...assignFor('RUN'), expectBranch: 'feat/add-auth' }))).toEqual({ ok: false, detail: 'invalid expectBranch' });
  });

  test('a CONFIG_EDIT ASSIGN with expectBranch is rejected', () => {
    expect(parseAssign(cmd({ ...assignFor('CONFIG_EDIT'), expectBranch: 'feat/add-auth' }))).toEqual({ ok: false, detail: 'invalid expectBranch' });
  });

  test('a THREAD ASSIGN with expectBranch is rejected', () => {
    const thread = { threadId: 't1', action: 'SESSION', feature: 'brainstorm-x', resume: false, instructions: '', backend: { kind: 'native' }, skills: [], initialMessage: null };
    expect(parseAssign(cmd({ ...assignFor('THREAD', { feature: 'thread-t1', thread } as never), expectBranch: 'feat/add-auth' }))).toEqual({ ok: false, detail: 'invalid expectBranch' });
  });

  test.each([
    ['an empty string', ''],
    ['a control character', 'feat/a\nb'],
    ['more than 255 characters', 'b'.repeat(256)],
    ['a number', 7],
    ['null', null],
  ])('a PLAN with %s as expectBranch is rejected', (_label, expectBranch) => {
    expect(parseAssign(cmd({ ...assignFor('PLAN'), expectBranch }))).toEqual({ ok: false, detail: 'invalid expectBranch' });
  });

  test('a PLAN accepts an expectBranch of exactly 255 characters (the ref rule)', () => {
    const expectBranch = 'b'.repeat(255);
    const parsed = parseAssign(cmd({ ...assignFor('PLAN'), expectBranch }));
    expect(parsed.ok && parsed.assign.expectBranch).toBe(expectBranch);
  });
});
