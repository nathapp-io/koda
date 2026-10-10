import type { ProfileNeeds, RunnerCapabilities } from '../common/protocol';
import {
  EMPTY_LOAD, evaluateRunners, firstMisfit, jobScopePause, orderCandidates, PERMANENT_MISFITS, PlacementJob, PlacementRunner, profileMisfit, QUEUED_SCAN_LIMIT,
  toLoads, toPlacementJob,
} from './placement-rules';

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
  command: 'RUN', repoId: 'repo-1', provider: 'github', profiles: ['fast'], selectorLabels: ['linux'], pinnedRunnerId: null, bashMode: 'raw', ...over,
});
const misfit = (j: PlacementJob, r: PlacementRunner, load = EMPTY_LOAD) => firstMisfit(j, r, load, NOW, 90);
const TG_FAILED = { ok: false, plugin: 'telegram', code: 'TELEGRAM_NOT_CONFIGURED' };
const brokenFast = { fast: { protocol: 'native' as const, providers: ['deepseek'], sandbox: true, interaction: TG_FAILED } };

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
    ['interaction', job(), runner({ capabilities: caps({ profiles: brokenFast }) })],
    ['interaction', job({ profiles: [] }), runner({ capabilities: caps({ interaction: TG_FAILED }) })],
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

  describe('approvals relay (S1.5 §3, plan D270)', () => {
    it.each(['gated', 'escalate'] as const)('a %s job needs a relay runner', (bashMode) => {
      expect(misfit(job({ bashMode }), runner())).toBe('approvals_relay');
      expect(misfit(job({ bashMode }), runner({ capabilities: caps({ approvals: { relay: true } }) }))).toBeNull();
    });
    it('a raw job does not care', () => {
      expect(misfit(job({ bashMode: 'raw' }), runner())).toBeNull();
    });
    it('is checked before tool misfits', () => {
      expect(misfit(job({ bashMode: 'escalate' }), runner({ capabilities: caps({ tools: { git: false, gh: false, glab: false } }) }))).toBe('approvals_relay');
    });
    it('is permanent (a pinned dispatch is refused)', () => {
      expect(PERMANENT_MISFITS.has('approvals_relay')).toBe(true);
    });
  });

  it('orders by fewest active jobs, then oldest lastSeenAt, then id', () => {
    const a = { runner: runner({ id: 'a', lastSeenAt: new Date(3) }), load: { active: 1, repoIds: new Set<string>() } };
    const b = { runner: runner({ id: 'b', lastSeenAt: new Date(2) }), load: { active: 0, repoIds: new Set<string>() } };
    const c = { runner: runner({ id: 'c', lastSeenAt: new Date(1) }), load: { active: 0, repoIds: new Set<string>() } };
    const d = { runner: runner({ id: 'd', lastSeenAt: new Date(1) }), load: { active: 0, repoIds: new Set<string>() } };
    expect(orderCandidates([a, b, d, c]).map((x) => x.runner.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  describe('config kinds (fleet S3 §3, D470)', () => {
    const cfg = (over: Partial<PlacementJob> = {}) => job({ command: 'CONFIG_EDIT', profiles: [], ...over });
    const s3 = (over: Partial<RunnerCapabilities> = {}) => caps({ configJobs: true, ...over });

    it('fits an S3 runner even when every agent check would fail', () => {
      const broken = s3({
        nax: { version: '1', protocols: ['acp'] }, credentials: [], sandbox: { available: false, probedAt: 'x' },
        interaction: TG_FAILED, approvals: undefined,
      });
      expect(misfit(cfg({ bashMode: 'gated' }), runner({ capabilities: broken }))).toBeNull();
      expect(misfit(cfg({ command: 'CONFIG_DRIFT' }), runner({ capabilities: broken }))).toBeNull();
    });

    it('gives a runner without the configJobs capability the permanent misfit config_jobs', () => {
      expect(misfit(cfg(), runner())).toBe('config_jobs');
      expect(PERMANENT_MISFITS.has('config_jobs')).toBe(true);
    });

    it('keeps the tools check', () => {
      expect(misfit(cfg({ provider: 'gitlab' }), runner({ capabilities: s3() }))).toBe('tools');
      expect(misfit(cfg(), runner({ capabilities: s3({ tools: { git: false, gh: true, glab: true } }) }))).toBe('tools');
    });

    it('skips budget_paused but keeps disabled, offline, labels, busy_repo and capacity', () => {
      const ok = runner({ capabilities: s3() });
      expect(misfit(cfg(), { ...ok, budgetPaused: true })).toBeNull();
      expect(misfit(job(), { ...runner(), budgetPaused: true })).toBe('budget_paused');
      expect(misfit(cfg(), { ...ok, enabled: false })).toBe('disabled');
      expect(misfit(cfg(), { ...ok, lastSeenAt: new Date(NOW.getTime() - 91_000) })).toBe('offline');
      expect(misfit(cfg({ selectorLabels: ['mac'] }), ok)).toBe('labels');
      expect(misfit(cfg(), ok, { active: 0, repoIds: new Set(['repo-1']) })).toBe('busy_repo');
      expect(misfit(cfg(), ok, { active: 1, repoIds: new Set(['other']) })).toBe('capacity');
    });

    it('carries the command through toPlacementJob', () => {
      const record = { command: 'CONFIG_DRIFT', repoId: 'repo-1', profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw' as const };
      expect(toPlacementJob(record as never, { provider: 'github' }).command).toBe('CONFIG_DRIFT');
    });

    it('never holds a config job on a job-scope budget pause', () => {
      const match = jest.fn(() => ({ id: 'policy-1' }));
      const scope = { projectId: 'p1', repoId: 'repo-1', pinnedRunnerId: null };
      expect(jobScopePause({ command: 'CONFIG_EDIT', ...scope }, match)).toBeNull();
      expect(match).not.toHaveBeenCalled();
      expect(jobScopePause({ command: 'RUN', ...scope }, match)).toEqual({ id: 'policy-1' });
      expect(match).toHaveBeenCalledWith(['global', 'project:p1', 'repo:repo-1']);
    });
  });
});

describe('THREAD placement (US-006)', () => {
  const threadJob = (over: Partial<PlacementJob> = {}) => job({ command: 'THREAD', profiles: [], thread: { backend: { kind: 'native' }, enabled: true }, ...over });
  const threadRunner = (over: Partial<PlacementRunner> = {}) => runner({ protocolVersion: 4, threadCapacity: 2, capabilities: caps({ threadBackends: { native: ['m1'], acp: [] } }), ...over });

  it('counts THREAD refs in their own load class', () => {
    expect(toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD' }]).get('r1')).toEqual({ active: 0, repoIds: new Set(), threads: 1 });
  });
  it('does not block a RUN job on a repo held by THREAD', () => {
    const threadLoad = toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD' }]).get('r1');
    expect(misfit(job({ repoId: 'rA' }), runner(), threadLoad ?? EMPTY_LOAD)).toBeNull();
  });
  it('fits THREAD despite finite capacity, same-repo load, and broken interaction/sandbox', () => {
    const capsWithIssues = caps({ threadBackends: { native: ['m1'], acp: [] }, interaction: TG_FAILED, sandbox: { available: false, probedAt: 'x' } });
    expect(misfit(threadJob(), threadRunner({ capabilities: capsWithIssues }), { active: 1, repoIds: new Set(['repo-1']), threads: 0 })).toBeNull();
  });
  it('reports thread capacity after backend fit', () => {
    expect(misfit(threadJob(), threadRunner(), { active: 0, repoIds: new Set(), threads: 2 })).toBe('thread_capacity');
  });
  it.each([
    [{ kind: 'native', model: 'm2' }, { native: ['m1'], acp: [] }],
    [{ kind: 'acp', agent: 'claude' }, { native: [], acp: [] }],
  ] as const)('reports unsupported thread backend', (backend, threadBackends) => {
    expect(misfit(threadJob({ thread: { backend, enabled: true } }), threadRunner({ capabilities: caps({ threadBackends }) }))).toBe('thread_backend');
  });
  it('requires protocol v4 and enabled thread placement', () => {
    expect(misfit(threadJob(), threadRunner({ protocolVersion: 3 }))).toBe('protocol');
    expect(misfit(threadJob({ thread: { backend: { kind: 'native' }, enabled: false } }), threadRunner())).toBe('threads_disabled');
    expect(misfit(threadJob({ thread: undefined }), threadRunner())).toBe('threads_disabled');
  });
});

describe('evaluateRunners (S2b (c) §2.3)', () => {
  it('returns one verdict per runner, applying each runner pause and load', () => {
    const loads = new Map([['r2', { active: 1, repoIds: new Set(['other-repo']) }]]);
    const out = evaluateRunners(job(), [runner({ id: 'r1' }), runner({ id: 'r2' }), runner({ id: 'r3' })], loads, (id) => id === 'r3', NOW, 90);
    expect(out.map((v) => [v.runner.id, v.reason])).toEqual([['r1', null], ['r2', 'capacity'], ['r3', 'budget_paused']]);
    expect(out[2].runner.budgetPaused).toBe(true);
    expect(out[0].runner.budgetPaused).toBe(false);
    expect(out[0].load).toBe(EMPTY_LOAD);
  });

  it("keeps the caller's runner type (placeJob needs bootId back)", () => {
    const [v] = evaluateRunners(job(), [{ ...runner(), bootId: 'boot-9' }], new Map(), () => false, NOW, 90);
    expect(v.runner.bootId).toBe('boot-9');
  });

  it('agrees with firstMisfit for a pinned job: labels are ignored', () => {
    const pinned = job({ pinnedRunnerId: 'r1', selectorLabels: ['nope'] });
    const [v] = evaluateRunners(pinned, [runner()], new Map(), () => false, NOW, 90);
    expect(v.reason).toBe(misfit(pinned, runner()));
  });
});

describe('placement helpers moved from PlacementService (D413)', () => {
  it('toLoads counts held jobs and their repos per runner', () => {
    const loads = toLoads([{ runnerId: 'r1', repoId: 'a' }, { runnerId: 'r1', repoId: 'b' }, { runnerId: 'r2', repoId: 'a' }]);
    expect(loads.get('r1')).toEqual({ active: 2, repoIds: new Set(['a', 'b']) });
    expect(loads.get('r2')).toEqual({ active: 1, repoIds: new Set(['a']) });
    expect(loads.get('r3')).toBeUndefined();
  });

  it('toPlacementJob copies the placement fields and the repo provider', () => {
    expect(toPlacementJob({ command: 'RUN', repoId: 'x', profiles: ['p'], selectorLabels: ['l'], pinnedRunnerId: null, bashMode: 'gated' }, { provider: 'gitlab' }))
      .toEqual({ command: 'RUN', repoId: 'x', provider: 'gitlab', profiles: ['p'], selectorLabels: ['l'], pinnedRunnerId: null, bashMode: 'gated' });
  });

  it('keeps the placement scan window at 50', () => {
    expect(QUEUED_SCAN_LIMIT).toBe(50);
  });
});

describe('#207: interaction plugin checks', () => {
  it('judges a job that names profiles on those profiles only, not on the base config', () => {
    const r = runner({ capabilities: caps({ interaction: TG_FAILED }) });
    expect(misfit(job(), r)).toBeNull();
  });

  it('treats a profile the runner does not report as unknowable, even when the base config is broken', () => {
    const r = runner({ capabilities: caps({ interaction: TG_FAILED }) });
    expect(misfit(job({ profiles: ['repo-provided'] }), r)).toBeNull();
  });

  it('treats absent results (older nax) and ok results as fits', () => {
    expect(misfit(job({ profiles: [] }), runner())).toBeNull();
    const ok = { ok: true, plugin: null };
    const r = runner({ capabilities: caps({ interaction: ok, profiles: { fast: { ...brokenFast.fast, interaction: ok } } }) });
    expect(misfit(job(), r)).toBeNull();
    expect(misfit(job({ profiles: [] }), r)).toBeNull();
  });

  it('is a waiting reason, not a permanent one: an env fix and a re-probe clear it', () => {
    expect(PERMANENT_MISFITS.has('interaction')).toBe(false);
  });

  it('reports sandbox before interaction on the same profile (placement order)', () => {
    const r = runner({ capabilities: caps({ profiles: brokenFast, sandbox: { available: false, probedAt: 'x' } }) });
    expect(misfit(job(), r)).toBe('sandbox');
  });
});

describe('profileMisfit (S3 §4.4: one profile, the placement rules)', () => {
  const needs = (over: Partial<ProfileNeeds> = {}): ProfileNeeds => ({ protocol: 'native', providers: ['deepseek'], sandbox: true, ...over });

  it('fits when protocol, providers, sandbox and interaction are fine', () => {
    expect(profileMisfit(needs(), caps())).toBeNull();
  });

  it('reports, in placement order, protocol, provider_missing, provider_unavailable, sandbox, interaction', () => {
    expect(profileMisfit(needs({ protocol: 'acp' }), caps())).toBe('protocol');
    expect(profileMisfit(needs({ providers: ['openai'] }), caps())).toBe('provider_missing');
    expect(profileMisfit(needs(), caps({ credentials: [cred({ available: false })] }))).toBe('provider_unavailable');
    expect(profileMisfit(needs(), caps({ sandbox: { available: false, probedAt: NOW.toISOString() } }))).toBe('sandbox');
    expect(profileMisfit(needs({ interaction: TG_FAILED }), caps())).toBe('interaction');
  });
});
