import { ValidationAppException } from '@nathapp/nestjs-common';
import { GIT_REF_RE, normalizeDispatch } from './dispatch-input';
import type { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';

const dto = (over: Partial<DispatchFleetJobDto> = {}): DispatchFleetJobDto =>
  Object.assign({ repoId: 'repo-1', command: 'RUN', feature: 'auth-flow', maxCostUsd: 5 }, over) as DispatchFleetJobDto;

describe('normalizeDispatch (spec §5.1)', () => {
  it('fills defaults', () => {
    expect(normalizeDispatch(dto(), 'trunk')).toEqual({
      repoId: 'repo-1', ref: 'trunk', command: 'RUN', feature: 'auth-flow', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null,
    });
  });

  it('normalizes REVIEW inputs from the PR number and default branch', () => {
    expect(normalizeDispatch(dto({ command: 'REVIEW', feature: undefined, prNumber: 42 } as Partial<DispatchFleetJobDto>), 'main'))
      .toEqual(expect.objectContaining({ command: 'REVIEW', feature: 'review-pr-42', ref: 'main', planFrom: null, bashMode: 'raw' }));
  });

  it.each([
    ['missing PR number', { command: 'REVIEW', feature: undefined }, 'prNumber required for REVIEW'],
    ['provided feature', { command: 'REVIEW', feature: 'something', prNumber: 42 }, 'feature is derived for REVIEW'],
    ['planFrom', { command: 'REVIEW', feature: undefined, prNumber: 42, planFrom: 'docs/a.md' }, 'planFrom is only for PLAN'],
    ['ref', { command: 'REVIEW', feature: undefined, prNumber: 42, ref: 'other' }, 'ref is the default branch for REVIEW'],
    ['bash mode', { command: 'REVIEW', feature: undefined, prNumber: 42, bashMode: 'escalate' }, 'bashMode must be raw for REVIEW'],
    ['ticket refs', { command: 'REVIEW', feature: undefined, prNumber: 42, ticketRefs: ['KD-1'] }, 'ticketRefs is not for REVIEW'],
    ['missing RUN feature', { command: 'RUN', feature: undefined }, 'feature'],
    ['reserved feature', { command: 'RUN', feature: 'review-pr-5' }, 'feature is reserved for REVIEW'],
    ['PR number on RUN', { command: 'RUN', prNumber: 3 }, 'prNumber is only for REVIEW'],
  ])('rejects %s', (_label, input, reason) => {
    expect(() => normalizeDispatch(dto(input as Partial<DispatchFleetJobDto>), 'main'))
      .toThrow(expect.objectContaining({ args: { reason } }));
  });

  it('keeps profile order and sorts/dedups labels', () => {
    const out = normalizeDispatch(dto({ profiles: ['b', 'a'], selectorLabels: ['linux', 'gpu', 'linux'] }), 'main');
    expect(out.profiles).toEqual(['b', 'a']);
    expect(out.selectorLabels).toEqual(['gpu', 'linux']);
  });

  it.each([
    ['PLAN without planFrom', dto({ command: 'PLAN' })],
    ['RUN with planFrom', dto({ planFrom: 'docs/spec.md' })],
    ['absolute planFrom', dto({ command: 'PLAN', planFrom: '/etc/passwd' })],
    ['planFrom escaping the repo', dto({ command: 'PLAN', planFrom: 'docs/../../x.md' })],
    ['planFrom with a backslash', dto({ command: 'PLAN', planFrom: 'docs\\spec.md' })],
    ['planFrom starting with a dash', dto({ command: 'PLAN', planFrom: '-rf.md' })],
    ['a reserved per-job profile', dto({ profiles: ['koda-job-abc'] })],
    ['a duplicate profile', dto({ profiles: ['fast', 'fast'] })],
    ['a feature with ..', dto({ feature: 'a..b' })],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeDispatch(input, 'main')).toThrow(ValidationAppException);
  });

  it.each([['main', true], ['feature/x', true], ['v1.2.3', true], ['-x', false], ['.foo', false], ['.hidden/x', false], ['a..b', false], ['a//b', false], ['x.lock', false], ['x/', false], ['a b', false]])(
    'ref %s valid=%s', (ref, ok) => {
      expect(GIT_REF_RE.test(ref)).toBe(ok);
    },
  );
});

describe('bashMode and approvalTimeoutSec (S1.5 §1.6)', () => {
  const run = { repoId: 'r1', command: 'RUN' as const, feature: 'f', maxCostUsd: 5 };

  it('defaults to raw and 600 s', () => {
    expect(normalizeDispatch(run, 'main')).toEqual(expect.objectContaining({ bashMode: 'raw', approvalTimeoutSec: 600 }));
  });
  it.each(['gated', 'escalate'] as const)('keeps %s with its timeout for RUN', (bashMode) => {
    expect(normalizeDispatch({ ...run, bashMode, approvalTimeoutSec: 90 }, 'main'))
      .toEqual(expect.objectContaining({ bashMode, approvalTimeoutSec: 90 }));
  });
  it('refuses a non-raw PLAN', () => {
    expect(() => normalizeDispatch({ ...run, command: 'PLAN', planFrom: 'docs/s.md', bashMode: 'escalate' }, 'main'))
      .toThrow(expect.objectContaining({ args: { reason: 'bashMode must be raw for PLAN' } }));
  });
  it('stores the timeout of a raw job too (unused)', () => {
    expect(normalizeDispatch({ ...run, approvalTimeoutSec: 45 }, 'main').approvalTimeoutSec).toBe(45);
  });
});
