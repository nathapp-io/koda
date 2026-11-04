import type { ProfileNeeds, RunnerCapabilities } from '../common/protocol';
import { parseCapabilitiesCore } from '../common/capabilities-core';
import { MISFIT_REASONS } from '../dashboard/dashboard.types';
import {
  EMPTY_LOAD, evaluateRunners, firstMisfit, jobScopePause, MAX_QUEUED_SCAN_PAGES, orderCandidates, PERMANENT_MISFITS, PlacementJob, PlacementRunner, profileMisfit, QUEUED_SCAN_LIMIT,
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
  command: 'RUN', repoId: 'repo-1', projectId: 'p1', provider: 'github', profiles: ['fast'], selectorLabels: ['linux'], pinnedRunnerId: null, bashMode: 'raw', ...over,
});
const misfit = (j: PlacementJob, r: PlacementRunner, load = EMPTY_LOAD) => firstMisfit(j, r, load, NOW, 90);
const TG_FAILED = { ok: false, plugin: 'telegram', code: 'TELEGRAM_NOT_CONFIGURED' };
const brokenFast = { fast: { protocol: 'native' as const, providers: ['deepseek'], sandbox: true, interaction: TG_FAILED } };

describe('placement rules (spec §4)', () => {
  it('AC-5: mode-capable sessions fail closed on old runners; read stays compatible', () => {
    const r = runner({ protocolVersion: 4, threadCapacity: 2, capabilities: caps({ threadBackends: { native: ['m1'], acp: ['cursor'] }, threadWrite: true }) });
    for (const mode of ['ask', 'full'] as const) {
      for (const backend of [{ kind: 'native' as const }, { kind: 'acp' as const, agent: 'cursor' as const }]) {
        const j = job({ command: 'THREAD', thread: { enabled: true, backend, mode } });
        expect(misfit(j, r)).toBe('thread_modes');
        expect(misfit(j, { ...r, capabilities: { ...r.capabilities, threadModes: true } })).toBeNull();
        expect(misfit({ ...j, thread: { enabled: true, backend, mode, action: 'PUBLISH' } }, r)).toBeNull();
      }
    }
    expect(misfit(job({ command: 'THREAD', thread: { enabled: true, backend: { kind: 'native' }, mode: 'read' } }), r)).toBeNull();
    expect(MISFIT_REASONS).toContain('thread_modes');
  });
  it('requires botReview first for REVIEW jobs, but fits a capable matching runner', () => {
    const review = job({ command: 'REVIEW' });
    expect(misfit(review, runner())).toBe('bot_review');
    expect(misfit(review, runner({ capabilities: caps({ botReview: true, profiles: {} }) }))).toBeNull();
    expect(misfit(review, runner({ capabilities: caps({ profiles: {} }) }))).toBe('bot_review');
    expect(PERMANENT_MISFITS.has('bot_review')).toBe(false);
    expect(MISFIT_REASONS).toContain('bot_review');
  });

  it('US-003 AC-3: FIX without either capability reports bot_review first', () => {
    expect(misfit(job({ command: 'FIX' }), runner())).toBe('bot_review');
  });

  it('US-003 AC-4: FIX with botReview but no botFix reports bot_fix', () => {
    expect(misfit(job({ command: 'FIX' }), runner({ capabilities: caps({ botReview: true }) }))).toBe('bot_fix');
  });

  it('US-003 AC-5: FIX fits a runner with both capabilities and matching profiles', () => {
    expect(misfit(job({ command: 'FIX' }), runner({ capabilities: caps({ botReview: true, botFix: true }) }))).toBeNull();
  });

  it('US-003 AC-6: REVIEW remains compatible with botReview alone', () => {
    expect(misfit(job({ command: 'REVIEW' }), runner({ capabilities: caps({ botReview: true }) }))).toBeNull();
  });

  it('US-003 AC-7: bot_fix is recoverable and does not cancel the queued job', () => {
    expect(PERMANENT_MISFITS.has('bot_fix')).toBe(false);
  });

  it('US-003 AC-8: dashboard misfit reasons include bot_fix', () => {
    expect(MISFIT_REASONS).toContain('bot_fix');
  });

  it('US-004: trust_domain is recoverable and named by the dashboard reason list', () => {
    expect(PERMANENT_MISFITS.has('trust_domain')).toBe(false);
    expect(MISFIT_REASONS).toContain('trust_domain');
  });

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
    expect(misfit(job(), runner({ capacity: 2 }), { active: 1, repoIds: new Set(['repo-1']), projectIds: new Set(), rawProjectIds: new Set() })).toBe('busy_repo');
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
      expect(toPlacementJob(record as never, { provider: 'github', projectId: 'p1' }).command).toBe('CONFIG_DRIFT');
    });

    it('never holds a config job on a job-scope budget pause', () => {
      const match = vi.fn(() => ({ id: 'policy-1' }));
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

  it('counts THREAD refs in their own load class and preserves their project trust domain', () => {
    expect(toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD', projectId: 'p1', bashMode: 'raw' }]).get('r1')).toEqual({ active: 0, repoIds: new Set(), projectIds: new Set(['p1']), rawProjectIds: new Set(['p1']), threads: 1 });
  });
  it('does not block a RUN job on a repo held by THREAD', () => {
    const threadLoad = toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD', projectId: 'p1', bashMode: 'raw' }]).get('r1');
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
    expect(misfit(threadJob({ thread: { backend, enabled: true } }), threadRunner({ capabilities: caps({ threadBackends: { native: [...threadBackends.native], acp: [...threadBackends.acp] } }) }))).toBe('thread_backend');
  });
  it('requires protocol v4 and enabled thread placement', () => {
    expect(misfit(threadJob(), threadRunner({ protocolVersion: 3 }))).toBe('protocol');
    expect(misfit(threadJob({ thread: { backend: { kind: 'native' }, enabled: false } }), threadRunner())).toBe('threads_disabled');
    expect(misfit(threadJob({ thread: undefined }), threadRunner())).toBe('threads_disabled');
  });
});

describe('PROJECT thread placement (US-005)', () => {
  const threadJob = (kind: 'REPO' | 'PROJECT', model?: string) => job({
    command: 'THREAD', profiles: [], selectorLabels: [],
    thread: { backend: { kind: 'native', ...(model ? { model } : {}) }, enabled: true, kind },
  });
  const threadRunner = (over: Partial<RunnerCapabilities> = {}, runnerOver: Partial<PlacementRunner> = {}) => runner({
    protocolVersion: 4, threadCapacity: 2, capabilities: caps({ threadBackends: { native: ['m1'], acp: [] }, ...over }), ...runnerOver,
  });
  const freeCapacity = { active: 0, repoIds: new Set<string>(), threads: 0 };

  it('AC-8: reports project_threads for a PROJECT thread on a runner without projectThreads', () => {
    expect(misfit(threadJob('PROJECT', 'm1'), threadRunner(), freeCapacity)).toBe('project_threads');
  });

  it('AC-9: fits a PROJECT thread on a runner with projectThreads, the named model and free thread capacity', () => {
    expect(misfit(threadJob('PROJECT', 'm1'), threadRunner({ projectThreads: true }), freeCapacity)).toBeNull();
  });

  it('AC-10: fits a REPO thread on a runner without projectThreads', () => {
    expect(misfit(threadJob('REPO', 'm1'), threadRunner(), freeCapacity)).toBeNull();
  });

  it('AC-11: reports protocol before project_threads on a protocol-3 runner', () => {
    expect(misfit(threadJob('PROJECT', 'm1'), threadRunner({}, { protocolVersion: 3 }), freeCapacity)).toBe('protocol');
  });

  it('AC-12: project_threads is a waiting reason, never permanent', () => {
    expect(PERMANENT_MISFITS.has('project_threads')).toBe(false);
  });
});

describe('ACP thread placement on every kind (thread-agents-modes US-001)', () => {
  // The runner's capabilities are built through the real parser, so these cases exercise the admitted agent set and
  // the placement rule together: a runner can only advertise an agent the API accepts.
  const report = (acp: string[]): RunnerCapabilities => parseCapabilitiesCore({
    nax: { version: '0.83.0', protocols: ['native', 'acp'] },
    sandbox: { available: true, probedAt: NOW.toISOString() },
    profiles: {},
    credentials: [cred()],
    tools: { git: true, gh: true, glab: false },
    executors: ['host'],
    projectThreads: true,
    threadBackends: { native: [], acp },
  });
  const acpRunner = (acp: string[]): PlacementRunner => runner({ protocolVersion: 4, threadCapacity: 2, capabilities: report(acp) });
  const session = (agent: 'cursor' | 'claude'): PlacementJob => job({
    command: 'THREAD', profiles: [], selectorLabels: [],
    thread: { kind: 'PROJECT', enabled: true, action: 'SESSION', backend: { kind: 'acp', agent } },
  });

  it('AC-12: answers no misfit for a PROJECT SESSION on acp cursor when the runner advertises cursor', () => {
    expect(misfit(session('cursor'), acpRunner(['cursor']), EMPTY_LOAD)).toBeNull();
  });

  it('AC-13: answers thread_backend for the same job on a runner advertising claude only', () => {
    expect(misfit(session('cursor'), acpRunner(['claude']), EMPTY_LOAD)).toBe('thread_backend');
  });

  it('AC-13: answers thread_backend when the runner advertises no ACP agent at all', () => {
    expect(misfit(session('cursor'), acpRunner([]), EMPTY_LOAD)).toBe('thread_backend');
  });

  it('AC-12 control: the same runner fits the agent it does advertise', () => {
    // Without this control the two cases above would also pass on a rule that refused every ACP job.
    expect(misfit(session('claude'), acpRunner(['claude']), EMPTY_LOAD)).toBeNull();
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
    const loads = toLoads([
      { runnerId: 'r1', repoId: 'a', projectId: 'p1', bashMode: 'gated' },
      { runnerId: 'r1', repoId: 'b', projectId: 'p2', bashMode: 'raw' },
      { runnerId: 'r2', repoId: 'a', projectId: 'p1', bashMode: 'gated' },
    ]);
    expect(loads.get('r1')).toEqual({ active: 2, repoIds: new Set(['a', 'b']), projectIds: new Set(['p1', 'p2']), rawProjectIds: new Set(['p2']), threads: 0 });
    expect(loads.get('r2')).toEqual({ active: 1, repoIds: new Set(['a']), projectIds: new Set(['p1']), rawProjectIds: new Set(), threads: 0 });
    expect(loads.get('r3')).toBeUndefined();
  });

  it('toPlacementJob copies the placement fields, the repo provider and the project', () => {
    expect(toPlacementJob({ command: 'RUN', repoId: 'x', profiles: ['p'], selectorLabels: ['l'], pinnedRunnerId: null, bashMode: 'gated' }, { provider: 'gitlab', projectId: 'p7' }))
      .toEqual({ command: 'RUN', repoId: 'x', projectId: 'p7', provider: 'gitlab', profiles: ['p'], selectorLabels: ['l'], pinnedRunnerId: null, bashMode: 'gated' });
  });

  it('keeps the placement scan window at 50', () => {
    expect(QUEUED_SCAN_LIMIT).toBe(50);
  });

  it('AC-1 (US-004): bounds a fill scan at 10 pages', () => {
    expect(MAX_QUEUED_SCAN_PAGES).toBe(10);
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

  it('US-001 AC11: thread_write is a waiting reason (a runner restart or re-probe clears it), not permanent', () => {
    expect(PERMANENT_MISFITS.has('thread_write')).toBe(false);
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


describe('workspace placement AC-2/3/4', () => {
  const workspace = job({ command: 'THREAD', thread: { kind: 'WORKSPACE', enabled: true, backend: { kind: 'native', model: 'm1' } } });
  const host = (workspaceThreads?: boolean) => runner({ protocolVersion: 4, threadCapacity: 2, capabilities: caps({ projectThreads: true, workspaceThreads, threadBackends: { native: ['m1'], acp: [] } }) });
  it('requires workspaceThreads', () => expect(misfit(workspace, host())).toBe('workspace_threads'));
  it('fits a workspace host', () => expect(misfit(workspace, host(true))).toBeNull());
  it('keeps workspace_threads recoverable', () => expect((PERMANENT_MISFITS as ReadonlySet<string>).has('workspace_threads')).toBe(false));
});
