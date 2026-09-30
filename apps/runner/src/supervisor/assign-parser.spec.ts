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
    ['bashMode gated', { ...assignFor(), bashMode: 'gated' }, 'bashMode'],
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
