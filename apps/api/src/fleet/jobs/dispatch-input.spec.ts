import { ValidationAppException } from '@nathapp/nestjs-common';
import { GIT_REF_RE, normalizeDispatch } from './dispatch-input';
import type { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';

const dto = (over: Partial<DispatchFleetJobDto> = {}): DispatchFleetJobDto =>
  Object.assign({ repoId: 'repo-1', command: 'RUN', feature: 'auth-flow', maxCostUsd: 5 }, over) as DispatchFleetJobDto;

describe('normalizeDispatch (spec §5.1)', () => {
  it('fills defaults', () => {
    expect(normalizeDispatch(dto(), 'trunk')).toEqual({
      repoId: 'repo-1', ref: 'trunk', command: 'RUN', feature: 'auth-flow', planFrom: null, profiles: [],
      maxCostUsd: '5', bashMode: 'raw', selectorLabels: [], pinnedRunnerId: null,
    });
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
