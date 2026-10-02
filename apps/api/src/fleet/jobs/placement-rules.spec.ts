import type { RunnerCapabilities } from '../common/protocol';
import { EMPTY_LOAD, firstMisfit, orderCandidates, PERMANENT_MISFITS, PlacementJob, PlacementRunner } from './placement-rules';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const cred = (over: Record<string, unknown> = {}) => ({ providerId: 'deepseek', available: true, stored: null, ambient: false, ...over });
const caps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: NOW.toISOString() },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: true } },
  credentials: [cred()],
  tools: { git: true, gh: true, glab: false },
  executors: ['host'],
  ...over,
});
const runner = (over: Partial<PlacementRunner> = {}): PlacementRunner => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 10_000),
  labels: ['linux', 'gpu'], capacity: 1, capabilities: caps(), ...over,
});
const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  repoId: 'repo-1', provider: 'github', profiles: ['fast'], selectorLabels: ['linux'], pinnedRunnerId: null, ...over,
});
const misfit = (j: PlacementJob, r: PlacementRunner, load = EMPTY_LOAD) => firstMisfit(j, r, load, NOW, 90);

describe('placement rules (spec §4)', () => {
  it('fits a matching runner', () => {
    expect(misfit(job(), runner())).toBeNull();
  });

  it.each([
    ['disabled', job(), runner({ enabled: false })],
    ['offline', job(), runner({ lastSeenAt: new Date(NOW.getTime() - 91_000) })],
    ['labels', job({ selectorLabels: ['linux', 'mac'] }), runner()],
    ['executor', job(), runner({ capabilities: caps({ executors: [] }) })],
    ['protocol', job(), runner({ capabilities: caps({ nax: { version: '1', protocols: ['acp'] } }) })],
    ['provider_missing', job(), runner({ capabilities: caps({ credentials: [] }) })],
    ['provider_unavailable', job(), runner({ capabilities: caps({ credentials: [cred({ available: false })] }) })],
    ['sandbox', job(), runner({ capabilities: caps({ sandbox: { available: false, probedAt: 'x' } }) })],
    ['tools', job({ provider: 'gitlab' }), runner()],
    ['tools', job(), runner({ capabilities: caps({ tools: { git: false, gh: true, glab: true } }) })],
  ])('reports %s', (reason, j, r) => {
    expect(misfit(j, r)).toBe(reason);
  });

  it('follows nax: an expired stored oauth token with available=true still fits (nax refreshes it itself)', () => {
    const credentials = [cred({ stored: { kind: 'oauth', expires: '2026-10-01T11:59:59.000Z', expired: true }, available: true })];
    expect(misfit(job(), runner({ capabilities: caps({ credentials }) }))).toBeNull();
  });

  it('treats an unavailable provider as a waiting reason, not a permanent one', () => {
    expect(PERMANENT_MISFITS.has('provider_unavailable')).toBe(false);
    expect(PERMANENT_MISFITS.has('provider_missing')).toBe(true);
    expect((PERMANENT_MISFITS as ReadonlySet<string>).has('provider_expired')).toBe(false);
  });

  it('reports the first failing provider in profile order, missing or unavailable', () => {
    const profile = (providers: string[]) => ({ p: { protocol: 'native' as const, providers, sandbox: false } });
    const credentials = [cred({ available: false })]; // deepseek is present but unavailable, openai is absent
    const missingFirst = runner({ capabilities: caps({ profiles: profile(['openai', 'deepseek']), credentials }) });
    const unavailableFirst = runner({ capabilities: caps({ profiles: profile(['deepseek', 'openai']), credentials }) });
    expect(misfit(job({ profiles: ['p'] }), missingFirst)).toBe('provider_missing');
    expect(misfit(job({ profiles: ['p'] }), unavailableFirst)).toBe('provider_unavailable');
  });

  it('reports busy_repo before capacity, and capacity when full', () => {
    expect(misfit(job(), runner({ capacity: 2 }), { active: 1, repoIds: new Set(['repo-1']) })).toBe('busy_repo');
    expect(misfit(job(), runner({ capacity: 2 }), { active: 2, repoIds: new Set(['other']) })).toBe('capacity');
    expect(misfit(job(), runner({ capacity: 2 }), { active: 1, repoIds: new Set(['other']) })).toBeNull();
  });

  it('skips the needs check for a profile the runner does not know (repo-provided, spec §2.1)', () => {
    expect(misfit(job({ profiles: ['repo-only'] }), runner({ capabilities: caps({ credentials: [] }) }))).toBeNull();
  });

  it('never treats an inherited object key as a machine profile', () => {
    expect(misfit(job({ profiles: ['constructor', 'toString'] }), runner())).toBeNull();
  });

  it('ignores selector labels for a pinned job', () => {
    expect(misfit(job({ pinnedRunnerId: 'r1', selectorLabels: ['mac'] }), runner())).toBeNull();
  });

  it('classifies waiting reasons as not permanent', () => {
    expect(['offline', 'busy_repo', 'capacity', 'labels'].some((r) => PERMANENT_MISFITS.has(r as never))).toBe(false);
    expect(PERMANENT_MISFITS.has('disabled')).toBe(true);
  });

  it('reports budget_paused after offline and before labels, and never as permanent (S1b §2.3)', () => {
    expect(misfit(job(), runner({ budgetPaused: true }))).toBe('budget_paused');
    expect(misfit(job(), runner({ budgetPaused: true, lastSeenAt: new Date(NOW.getTime() - 91_000) }))).toBe('offline');
    expect(misfit(job({ selectorLabels: ['mac'] }), runner({ budgetPaused: true }))).toBe('budget_paused');
    expect(misfit(job(), runner({ budgetPaused: false }))).toBeNull();
    expect(PERMANENT_MISFITS.has('budget_paused')).toBe(false);
  });

  it('orders by fewest active jobs, then oldest lastSeenAt, then id', () => {
    const a = { runner: runner({ id: 'a', lastSeenAt: new Date(3) }), load: { active: 1, repoIds: new Set<string>() } };
    const b = { runner: runner({ id: 'b', lastSeenAt: new Date(2) }), load: { active: 0, repoIds: new Set<string>() } };
    const c = { runner: runner({ id: 'c', lastSeenAt: new Date(1) }), load: { active: 0, repoIds: new Set<string>() } };
    const d = { runner: runner({ id: 'd', lastSeenAt: new Date(1) }), load: { active: 0, repoIds: new Set<string>() } };
    expect(orderCandidates([a, b, d, c]).map((x) => x.runner.id)).toEqual(['c', 'd', 'b', 'a']);
  });
});
