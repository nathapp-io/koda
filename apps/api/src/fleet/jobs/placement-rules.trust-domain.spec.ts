import { EMPTY_LOAD, addJobToLoad, firstMisfit, PERMANENT_MISFITS, toPlacementJob } from './placement-rules';
import type { PlacementJob, PlacementRunner, RunnerLoad } from './placement-rules';

const now = new Date('2026-10-01T12:00:00.000Z');
const capabilities = { nax: { version: '1', protocols: ['native'] }, sandbox: { available: true, probedAt: now.toISOString() }, profiles: {}, credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'], configJobs: true, botReview: true, projectThreads: true, threadBackends: { native: ['m1'], acp: [] } } as const;
const runner: PlacementRunner = { id: 'r1', name: 'runner', enabled: true, lastSeenAt: now, labels: [], capacity: 4, protocolVersion: 4, threadCapacity: 4, capabilities };
const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({ command: 'RUN', repoId: 'repo1', projectId: 'p1', provider: 'github', profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', ...over });
const load = (projectIds: string[] = [], rawProjectIds: string[] = []): RunnerLoad => ({ active: 0, repoIds: new Set(), projectIds: new Set(projectIds), rawProjectIds: new Set(rawProjectIds), threads: 0 });
const fittingRunner = { ...runner, capabilities: { ...capabilities, approvals: { relay: true } } } as PlacementRunner;
const misfit = (j: PlacementJob, l: RunnerLoad) => firstMisfit(j, fittingRunner, l, now, 90);

describe('placement trust domains (US-003)', () => {
  it('AC-1 rejects raw RUN across projects', () => expect(misfit(job(), load(['p2']))).toBe('trust_domain'));
  it('AC-2 rejects non-raw jobs alongside another project raw job', () => expect(misfit(job({ bashMode: 'gated' }), load([], ['p2']))).toBe('trust_domain'));
  it('AC-3 allows non-raw jobs alongside another project non-raw job', () => expect(misfit(job({ bashMode: 'gated' }), load(['p2']))).toBeNull());
  it('AC-4 allows same-project raw jobs', () => expect(misfit(job({ command: 'REVIEW' }), load(['p1'], ['p1']))).toBeNull());
  it('AC-5 config jobs are not raw agents', () => expect(misfit(job({ command: 'CONFIG_EDIT' }), load(['p2']))).toBeNull());
  it('AC-6 config jobs still avoid another project raw job', () => expect(misfit(job({ command: 'CONFIG_EDIT' }), load([], ['p2']))).toBe('trust_domain'));
  it('AC-7 capabilities take precedence over trust domain', () => expect(firstMisfit(job(), { ...runner, capabilities: { ...capabilities, tools: { git: true, gh: false, glab: false } } }, load(['p2'], ['p2']), now, 90)).toBe('tools'));
  it('AC-8 checks project threads against other projects', () => expect(misfit(job({ command: 'THREAD', thread: { backend: { kind: 'native' }, enabled: true, kind: 'PROJECT' } }), load(['p2']))).toBe('trust_domain'));
  it('AC-9 copies projectId from repo', () => expect(toPlacementJob({ command: 'RUN', repoId: 'x', profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw' }, { provider: 'github', projectId: 'p1' }).projectId).toBe('p1'));
  it('AC-10 trust_domain is recoverable', () => expect(PERMANENT_MISFITS.has('trust_domain')).toBe(false));
  it('AC-11 tracks raw job projects without mutating input', () => {
    const result = addJobToLoad(EMPTY_LOAD, { runnerId: 'r1', repoId: 'repo1', command: 'RUN', projectId: 'p1', bashMode: 'raw' });
    expect(result.rawProjectIds).toEqual(new Set(['p1']));
    expect(result.projectIds).toEqual(new Set(['p1']));
    expect(EMPTY_LOAD.projectIds).toEqual(new Set());
  });
  it('AC-12/13 treats literal CONFIG as config-like', () => {
    const result = addJobToLoad(EMPTY_LOAD, { runnerId: 'r1', repoId: 'repo1', command: 'CONFIG', projectId: 'p1', bashMode: 'raw' });
    expect(result.projectIds).toEqual(new Set(['p1']));
    expect(result.rawProjectIds).toEqual(new Set());
  });
});
