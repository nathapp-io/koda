import { describe, expect, test } from 'bun:test';
import type { FleetCommandOut } from '@nathapp/fleet-protocol';
import { assignFor } from '../../test/helpers/assign';
import { parseAssign, __checked } from './assign-parser';
import { assertOwner, PathError } from '../paths/safe-segment';

const cmd = (payload: unknown, over: Partial<FleetCommandOut> = {}): FleetCommandOut => ({ commandId: 'c1', type: 'ASSIGN', jobId: 'j1', leaseEpoch: 1, payload: payload as never, ...over });

describe('parseAssign (D30)', () => {
  test('accepts a well-formed RUN and PLAN payload and returns a clean copy', () => {
    const run = assignFor('RUN', { profiles: ['fast', 'strict'] });
    expect(parseAssign(cmd({ ...run, extra: 'dropped' }))).toEqual({ ok: true, assign: run });
    const plan = assignFor('PLAN');
    expect(parseAssign(cmd(plan))).toEqual({ ok: true, assign: plan });
  });
  test('accepts a GitLab subgroup owner and a dotted repo', () => {
    const a = assignFor('RUN', { repo: { provider: 'gitlab', owner: 'infra/team', name: '.github', defaultBranch: 'trunk', cloneUrl: 'https://gitlab.com/infra/team/.github.git' } });
    expect(parseAssign(cmd(a))).toEqual({ ok: true, assign: a });
  });
  test.each([
    ['a payload that is not an object', 'x', 'payload'],
    ['a job id that differs from the command', { ...assignFor(), jobId: 'other' }, 'jobId'],
    ['a job id with a slash', { ...assignFor(), jobId: '../j1' }, 'jobId'],
    ['an unknown command', { ...assignFor(), command: 'DEPLOY' }, 'command'],
    ['an unknown provider', { ...assignFor(), repo: { ...assignFor().repo, provider: 'bitbucket' } }, 'repo'],
    ['an owner with ..', { ...assignFor(), repo: { ...assignFor().repo, owner: '..' } }, 'owner'],
    ['an owner named .jobs', { ...assignFor(), repo: { ...assignFor().repo, owner: '.jobs' } }, 'owner'],
    ['a repo name with a slash', { ...assignFor(), repo: { ...assignFor().repo, name: 'a/b' } }, 'repo name'],
    ['an ext:: clone url', { ...assignFor(), repo: { ...assignFor().repo, cloneUrl: 'ext::sh -c id' } }, 'cloneUrl'],
    ['an option-shaped clone url', { ...assignFor(), repo: { ...assignFor().repo, cloneUrl: '--upload-pack=x' } }, 'cloneUrl'],
    ['an empty default branch', { ...assignFor(), repo: { ...assignFor().repo, defaultBranch: '' } }, 'defaultBranch'],
    ['a feature with a slash', { ...assignFor(), feature: 'a/b' }, 'feature'],
    ['a PLAN without planFrom', { ...assignFor('PLAN'), planFrom: null }, 'planFrom'],
    ['a planFrom with ..', { ...assignFor('PLAN'), planFrom: '../../etc/passwd' }, 'planFrom'],
    ['a planFrom on a RUN', { ...assignFor('RUN'), planFrom: 'docs/x.md' }, 'planFrom'],
    ['a profile with a comma', { ...assignFor(), profiles: ['a,b'] }, 'profiles'],
    ['the reserved profile prefix', { ...assignFor(), profiles: ['koda-job-x'] }, 'profiles'],
    ['nine profiles', { ...assignFor(), profiles: Array.from({ length: 9 }, (_, i) => `p${i}`) }, 'profiles'],
    ['a cost of 1e9', { ...assignFor(), maxCostUsd: '1e9' }, 'maxCostUsd'],
    ['a numeric cost', { ...assignFor(), maxCostUsd: 5 }, 'maxCostUsd'],
    ['bashMode yolo', { ...assignFor(), bashMode: 'yolo' }, 'bashMode'],
    ['an identity with a newline', { ...assignFor(), gitIdentity: { name: 'a\nb', email: 'e@x' } }, 'gitIdentity'],
    ['a missing identity', { ...assignFor(), gitIdentity: undefined }, 'gitIdentity'],
    ['a ref over 255 characters', { ...assignFor(), ref: 'r'.repeat(256) }, 'ref'],
  ])('rejects %s', (_label, payload, detail) => {
    const parsed = parseAssign(cmd(payload));
    expect(parsed.ok).toBe(false);
    expect((parsed as { detail: string }).detail).toBe(`invalid ${detail}`);
  });
  test('an odd but syntactically plain ref is not rejected here; prepare turns it into a fixed reason', () => {
    expect(parseAssign(cmd({ ...assignFor(), ref: '--upload-pack=x' })).ok).toBe(true);
  });
  test('STYLE-5: a non-PathError thrown from a validator is re-thrown, not silently swallowed', () => {
    expect(__checked(() => assertOwner('a/b'))).toBe(true);
    expect(() => __checked(() => { throw new TypeError('boom'); })).toThrow(TypeError);
  });
  test('STYLE-5: a PathError thrown from a validator returns false (the parse-time rejection path)', () => {
    expect(__checked(() => { throw new PathError('invalid owner'); })).toBe(false);
  });
});

describe('REVIEW assignment (US-005)', () => {
  const review = (over: Record<string, unknown> = {}) => ({ ...assignFor('RUN'), command: 'REVIEW', bashMode: 'raw', review: { prNumber: 42, botLogin: 'koda-fleet[bot]' }, ...over });
  test('AC-1 accepts and cleans a review assignment', () => {
    expect(parseAssign(cmd(review()))).toMatchObject({ ok: true, assign: { command: 'REVIEW', review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } } });
  });
  test.each([
    ['AC-2 missing review', (({ review: _review, ...rest }) => rest)(review()), 'review'],
    ['AC-3 invalid bot login', review({ review: { prNumber: 42, botLogin: 'koda fleet' } }), 'review'],
    ['AC-4 invalid PR number', review({ review: { prNumber: 0, botLogin: 'koda-fleet[bot]' } }), 'review'],
    ['AC-5 invalid bash mode', review({ bashMode: 'escalate' }), 'bashMode'],
    ['AC-6 review on RUN', { ...assignFor('RUN'), review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } }, 'review'],
  ] as const)('%s', (_label, payload, detail) => {
    expect(parseAssign(cmd(payload))).toEqual({ ok: false, detail: `invalid ${detail}` });
  });
});

describe('FIX assignment (US-006)', () => {
  const fix = (over: Record<string, unknown> = {}) => ({ ...assignFor('RUN'), command: 'FIX', bashMode: 'raw', review: { prNumber: 3, botLogin: 'koda-fleet[bot]' }, ...over });
  test('AC-6 accepts FIX with review and raw bash mode', () => {
    expect(parseAssign(cmd(fix()))).toMatchObject({ ok: true, assign: { command: 'FIX', review: { prNumber: 3, botLogin: 'koda-fleet[bot]' }, bashMode: 'raw' } });
  });
  test('US-003 AC-1 accepts and copies trustDetectedChecks true for FIX', () => {
    const parsed = parseAssign(cmd(fix({ review: { prNumber: 4, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true } })));
    expect(parsed).toMatchObject({ ok: true, assign: { review: { prNumber: 4, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true } } });
  });
  test('US-003 AC-2 leaves trustDetectedChecks absent for FIX when not sent', () => {
    const parsed = parseAssign(cmd(fix()));
    expect(parsed.ok && parsed.assign.command === 'FIX' && parsed.assign.review).toEqual({ prNumber: 3, botLogin: 'koda-fleet[bot]' });
  });
  test.each([false, 'true'])("US-003 rejects invalid FIX trustDetectedChecks %p", (trustDetectedChecks) => {
    expect(parseAssign(cmd(fix({ review: { prNumber: 4, botLogin: 'koda-fleet[bot]', trustDetectedChecks } })))).toEqual({ ok: false, detail: 'invalid review' });
  });
  test('US-003 AC-5 rejects trustDetectedChecks on REVIEW', () => {
    const payload = { ...assignFor('RUN'), command: 'REVIEW', bashMode: 'raw', review: { prNumber: 42, botLogin: 'koda-fleet[bot]', trustDetectedChecks: true } };
    expect(parseAssign(cmd(payload))).toEqual({ ok: false, detail: 'invalid review' });
  });
  test('AC-7 rejects FIX without review', () => {
    const { review: _review, ...payload } = fix();
    expect(parseAssign(cmd(payload))).toEqual({ ok: false, detail: 'invalid review' });
  });
  test('AC-8 rejects FIX with gated bash mode', () => {
    expect(parseAssign(cmd(fix({ bashMode: 'gated' })))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });
});

describe('REVIEW decisions (US-004)', () => {
  const decision = (over: Record<string, unknown> = {}) => ({ id: 'm1', statement: 's', source: 'koda:memory/m1', ...over });
  const withDecisions = (decisions: unknown) => ({ ...assignFor('RUN'), command: 'REVIEW', bashMode: 'raw', review: { prNumber: 42, botLogin: 'koda-fleet[bot]', decisions } });
  const withoutDecisions = () => ({ ...assignFor('RUN'), command: 'REVIEW', bashMode: 'raw', review: { prNumber: 42, botLogin: 'koda-fleet[bot]' } });

  test('AC-1 preserves valid decisions', () => {
    const decisions = [{ id: 'm1', statement: 's', source: 'koda:memory/m1' }];
    expect(parseAssign(cmd(withDecisions(decisions)))).toMatchObject({ ok: true, assign: { review: { decisions } } });
  });
  test('AC-2 preserves an empty decisions array', () => {
    const parsed = parseAssign(cmd(withDecisions([])));
    expect(parsed.ok && parsed.assign.command === 'REVIEW' && parsed.assign.review?.decisions).toEqual([]);
  });
  test('AC-3 leaves decisions absent when the key is absent', () => {
    const parsed = parseAssign(cmd(withoutDecisions()));
    expect(parsed.ok && parsed.assign.command === 'REVIEW' && parsed.assign.review).toEqual({ prNumber: 42, botLogin: 'koda-fleet[bot]' });
  });
  test('AC-4 accepts all 100 decisions at inclusive field limits', () => {
    const decisions = Array.from({ length: 100 }, (_, i) => decision(i === 0
      ? { id: 'i'.repeat(64), statement: 's'.repeat(2000), source: 'x'.repeat(200) }
      : { id: `m${i}` }));
    const parsed = parseAssign(cmd(withDecisions(decisions)));
    expect(parsed.ok && parsed.assign.command === 'REVIEW' && parsed.assign.review?.decisions).toEqual(decisions);
  });
  test.each([
    ['AC-5 over 100 entries', Array.from({ length: 101 }, (_, i) => decision({ id: `m${i}` }))],
    ['AC-6 invalid id syntax', [decision({ id: 'bad id' })]],
    ['AC-7 id over 64 characters', [decision({ id: 'i'.repeat(65) })]],
    ['AC-8 duplicate ids', [decision(), decision({ statement: 'second' })]],
    ['AC-9 empty statement', [decision({ statement: '' })]],
    ['AC-10 statement over 2000 characters', [decision({ statement: 's'.repeat(2001) })]],
    ['AC-11 non-string statement', [decision({ statement: 5 })]],
    ['AC-12 source over 200 characters', [decision({ source: 'x'.repeat(201) })]],
    ['AC-13 non-object decision entry', ['m1']],
    ['AC-14 decisions is not an array', { id: 'm1', statement: 's' }],
  ])('%s rejects with invalid review', (_name, decisions) => {
    expect(parseAssign(cmd(withDecisions(decisions)))).toEqual({ ok: false, detail: 'invalid review' });
  });
  test('copies only validated decision fields', () => {
    const entry = { id: 'm1', statement: 's', source: 'koda:memory/m1', extra: 'discard' };
    const parsed = parseAssign(cmd(withDecisions([entry])));
    expect(parsed.ok && parsed.assign.command === 'REVIEW' && parsed.assign.review?.decisions).toEqual([{ id: 'm1', statement: 's', source: 'koda:memory/m1' }]);
    expect(parsed.ok && parsed.assign.command === 'REVIEW' && parsed.assign.review?.decisions?.[0]).not.toBe(entry);
  });
});

describe('bashMode and approvalTimeoutSec (S1.5 §4.1)', () => {
  test.each(['raw', 'gated', 'escalate'] as const)('accepts %s on RUN', (bashMode) => {
    const r = parseAssign(cmd(assignFor('RUN', { bashMode, approvalTimeoutSec: 90 })));
    expect(r.ok && r.assign.bashMode).toBe(bashMode);
    expect(r.ok && r.assign.approvalTimeoutSec).toBe(90);
  });
  test('refuses a non-raw PLAN', () => {
    expect(parseAssign(cmd(assignFor('PLAN', { bashMode: 'gated' })))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });
  test('refuses an unknown mode', () => {
    expect(parseAssign(cmd({ ...assignFor('RUN'), bashMode: 'yolo' } as never))).toEqual({ ok: false, detail: 'invalid bashMode' });
  });
  test.each([29, 3601, 1.5, '60'])('refuses approvalTimeoutSec %p', (approvalTimeoutSec) => {
    expect(parseAssign(cmd({ ...assignFor('RUN'), approvalTimeoutSec } as never))).toEqual({ ok: false, detail: 'invalid approvalTimeoutSec' });
  });
  test('defaults a missing timeout to 600 (a server that predates the field)', () => {
    const { approvalTimeoutSec: _omit, ...legacy } = assignFor('RUN');
    const r = parseAssign(cmd(legacy as never));
    expect(r.ok && r.assign.approvalTimeoutSec).toBe(600);
  });
});

describe('parseAssign: config jobs (S3 §3)', () => {
  test.each(['CONFIG_EDIT', 'CONFIG_DRIFT'] as const)('accepts a well-formed %s payload with cost "0"', (command) => {
    const a = assignFor(command);
    expect(a.maxCostUsd).toBe('0');
    expect(parseAssign(cmd(a))).toEqual({ ok: true, assign: a });
  });
  test.each([
    ['a planFrom', { ...assignFor('CONFIG_EDIT'), planFrom: 'docs/x.md' }, 'planFrom'],
    ['a profile', { ...assignFor('CONFIG_EDIT'), profiles: ['fast'] }, 'profiles'],
    ['a gated bash mode', { ...assignFor('CONFIG_DRIFT'), bashMode: 'gated' }, 'bashMode'],
  ])('rejects a config job with %s', (_label, payload, detail) => {
    expect(parseAssign(cmd(payload))).toEqual({ ok: false, detail: `invalid ${detail}` });
  });
});

describe('US-008 caller rulings', () => {
  const ruling = { item: 'D-1', ruling: 'confirm: checked', by: 'koda:agent:dev', at: '2026-01-01T00:00:00Z' };
  const rulings = { headSha: 'a'.repeat(40), rulings: [ruling] };
  const payload = (command = 'FIX', value: unknown = rulings) => ({ ...assignFor(), command, review: { prNumber: 4, botLogin: 'fleet[bot]', rulings: value } });
  test('AC-1 preserves valid FIX rulings and strips unknown fields', () => {
    const parsed = parseAssign(cmd(payload('FIX', { ...rulings, rulings: [{ ...ruling, rulingId: 'private' }] })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.assign.review?.rulings).toEqual(rulings);
  });
  test('AC-2 refuses REVIEW rulings', () => {
    expect(parseAssign(cmd(payload('REVIEW')))).toEqual({ ok: false, detail: 'invalid review' });
  });
  test('AC-3 refuses newline in by', () => {
    expect(parseAssign(cmd(payload('FIX', { ...rulings, rulings: [{ ...ruling, by: 'a\nb' }] })))).toEqual({ ok: false, detail: 'invalid review' });
  });
  test.each([
    null, { ...rulings, headSha: 'abc' }, { ...rulings, rulings: [] },
    { ...rulings, rulings: Array(101).fill(ruling) }, { ...rulings, rulings: [ruling, ruling] },
    ...[{ item: 'bad/item' }, { ruling: '' }, { ruling: 'x'.repeat(2001) }, { by: '' }, { by: 'x'.repeat(101) }, { by: 'a\rb' }, { at: 'yesterday' }, { at: '2026-01-01' }, { at: '2999-01-01T00:00:00Z' }].map(over => ({ ...rulings, rulings: [{ ...ruling, ...over }] })),
  ])('refuses malformed rulings %j', value => {
    expect(parseAssign(cmd(payload('FIX', value)))).toEqual({ ok: false, detail: 'invalid review' });
  });
});
