import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut, FleetJobKindName, RuleOverrideAssign } from '@nathapp/fleet-protocol';
import { assignFor } from '../../test/helpers/assign';
import { parseAssign } from './assign-parser';

const cmd = (payload: unknown, over: Partial<FleetCommandOut> = {}): FleetCommandOut => ({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: payload as never, ...over });

/** A rule override as the API sends it (US-008): the stored override, read when the job was assigned. */
const OVERRIDE: RuleOverrideAssign = { sha256: 'a'.repeat(64), rulesMode: 'merge', rules: [{ path: 'api.md', content: 'x' }] };

/** A thread block that parses on its own, so a THREAD payload is only wrong by its rule override. */
const THREAD = {
  threadId: 't1', action: 'SESSION', feature: 'thread-t1', resume: false, instructions: 'be helpful',
  backend: { kind: 'native', model: 'minimax/MiniMax-M3' },
  skills: [], initialMessage: { messageId: 'm1', text: 'hi' },
};

function payload(command: FleetJobKindName, ruleOverride: unknown = OVERRIDE): Record<string, unknown> {
  const base = command === 'THREAD'
    ? assignFor('THREAD', { feature: 'thread-t1', thread: THREAD } as never)
    : assignFor(command);
  return { ...base, ruleOverride } as unknown as Record<string, unknown>;
}

describe('parseAssign rule override (fleet #370 US-009)', () => {
  test('AC-1: a RUN assign carrying a rule override keeps it', () => {
    const parsed = parseAssign(cmd(payload('RUN')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.ruleOverride).toEqual(OVERRIDE);
  });

  test.each(['RUN', 'PLAN', 'REVIEW', 'FIX', 'AGENT'] as const)('AC-1: %s carries a rule override', (command) => {
    const base = command === 'REVIEW' || command === 'FIX'
      ? { ...assignFor(command), bashMode: 'raw', review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } }
      : command === 'AGENT'
        ? { ...assignFor(command), agent: { name: 'spec-reviewer', task: 'Review' } }
        : assignFor(command);
    const parsed = parseAssign(cmd({ ...base, ruleOverride: OVERRIDE }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.ruleOverride).toEqual(OVERRIDE);
  });

  test('AC-1: the copied override carries only the validated fields', () => {
    const parsed = parseAssign(cmd(payload('RUN', { ...OVERRIDE, extra: 'dropped' })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.ruleOverride).toEqual(OVERRIDE);
  });

  test('AC-1: an override with a context and a replace mode is copied whole', () => {
    const override: RuleOverrideAssign = { ...OVERRIDE, rulesMode: 'replace', context: { content: 'ctx', mode: 'replace' } };
    const parsed = parseAssign(cmd(payload('RUN', override)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.ruleOverride).toEqual(override);
  });

  test('AC-2: a rule path outside the rules directory is refused', () => {
    expect(parseAssign(cmd(payload('RUN', { ...OVERRIDE, rules: [{ path: '../x.md', content: 'x' }] }))))
      .toEqual({ ok: false, detail: 'invalid ruleOverride' });
  });

  test('AC-3: an unknown rulesMode is refused', () => {
    expect(parseAssign(cmd(payload('RUN', { ...OVERRIDE, rulesMode: 'append' }))))
      .toEqual({ ok: false, detail: 'invalid ruleOverride' });
  });

  test('AC-4: a sha256 that is not 64 lowercase hex characters is refused', () => {
    expect(parseAssign(cmd(payload('RUN', { ...OVERRIDE, sha256: 'a'.repeat(63) }))))
      .toEqual({ ok: false, detail: 'invalid ruleOverride' });
  });

  test('AC-5: a THREAD, CONFIG_EDIT or CONFIG_DRIFT assign never carries a rule override', () => {
    for (const command of ['THREAD', 'CONFIG_EDIT', 'CONFIG_DRIFT'] as const) {
      expect(parseAssign(cmd(payload(command)))).toEqual({ ok: false, detail: 'invalid ruleOverride' });
    }
  });

  test('an assign without a rule override keeps no ruleOverride key', () => {
    const parsed = parseAssign(cmd(assignFor('RUN')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.hasOwn(parsed.assign, 'ruleOverride')).toBe(false);
  });

  test.each([
    ['a ruleOverride that is not an object', 'x'],
    ['a ruleOverride that is null', null],
    ['an upper-case sha256', { ...OVERRIDE, sha256: 'A'.repeat(64) }],
    ['a sha256 that is not hex', { ...OVERRIDE, sha256: 'z'.repeat(64) }],
    ['rules that are not an array', { ...OVERRIDE, rules: {} }],
    ['more than fifty rules', { ...OVERRIDE, rules: Array.from({ length: 51 }, (_, i) => ({ path: `r${i}.md`, content: 'x' })) }],
    ['a rule that is not an object', { ...OVERRIDE, rules: ['api.md'] }],
    ['a rule path with an upper-case letter', { ...OVERRIDE, rules: [{ path: 'API.md', content: 'x' }] }],
    ['a rule path that is not a markdown file', { ...OVERRIDE, rules: [{ path: 'api.txt', content: 'x' }] }],
    ['a rule path with too many segments', { ...OVERRIDE, rules: [{ path: 'a/b/c/d/e.md', content: 'x' }] }],
    ['a rule content that is not a string', { ...OVERRIDE, rules: [{ path: 'api.md', content: 5 }] }],
    ['a context that is not an object', { ...OVERRIDE, context: 'x' }],
    ['a context without a mode', { ...OVERRIDE, context: { content: 'c' } }],
    ['a context with an unknown mode', { ...OVERRIDE, context: { content: 'c', mode: 'merge' } }],
    ['a context content that is not a string', { ...OVERRIDE, context: { content: 5, mode: 'append' } }],
  ])('refuses %s', (_label, ruleOverride) => {
    expect(parseAssign(cmd(payload('RUN', ruleOverride)))).toEqual({ ok: false, detail: 'invalid ruleOverride' });
  });
});
