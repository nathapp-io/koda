import type { RunnerCapabilities } from '../common/protocol';
import { EMPTY_LOAD, PlacementJob, PlacementRunner, RunnerLoad } from './placement-rules';
import { judgeUnplaceable, UnplaceableJudgement } from './unplaceable-verdict';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const cred = { providerId: 'deepseek', available: true, stored: null, ambient: false };
const caps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: NOW.toISOString() },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [cred],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
  approvals: { relay: true },
  ...over,
});
const runner = (over: Partial<PlacementRunner> = {}): PlacementRunner => ({
  id: 'r1', name: 'box-1', enabled: true, lastSeenAt: new Date(NOW.getTime() - 10_000),
  labels: ['linux'], capacity: 2, capabilities: caps(), ...over,
});
const job = (over: Partial<PlacementJob> = {}): PlacementJob => ({
  command: 'RUN', repoId: 'repo-1', projectId: 'p1', provider: 'github', profiles: ['fast'], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', ...over,
});
const load = (over: Partial<RunnerLoad> = {}): RunnerLoad => ({ ...EMPTY_LOAD, ...over });

const judge = (over: Partial<Parameters<typeof judgeUnplaceable>[0]> = {}): UnplaceableJudgement | null => judgeUnplaceable({
  job: job(), scopePaused: false, pool: [runner()], loads: new Map<string, RunnerLoad>(), runnerPaused: () => false, now: NOW, offlineSec: 90, ...over,
});

/** A THREAD job whose turn a protocol-4 runner with the backend can host. */
const threadJob = (over: Partial<PlacementJob> = {}): PlacementJob => job({
  command: 'THREAD', profiles: [], thread: { enabled: true, kind: 'REPO', action: 'SESSION', mode: 'read', backend: { kind: 'native', model: 'm1' } }, ...over,
});
const host = (over: Partial<PlacementRunner> = {}): PlacementRunner => runner({
  protocolVersion: 4, threadCapacity: 2, capabilities: caps({ threadBackends: { native: ['m1'], acp: [] } }), ...over,
});

describe('judgeUnplaceable (US-002)', () => {
  it('AC-1: a paused job scope is budget_paused (warning) with no misfits', () => {
    expect(judge({ scopePaused: true })).toEqual({ verdict: 'budget_paused', severity: 'warning', misfits: [] });
  });

  it('AC-2: an empty candidate pool is no_runners (error) with no misfits', () => {
    expect(judge({ pool: [] })).toEqual({ verdict: 'no_runners', severity: 'error', misfits: [] });
  });

  it('AC-3: a runner that fits the job makes it delayed, not unplaceable', () => {
    expect(judge({ pool: [runner({ id: 'r1' }), runner({ id: 'r2', enabled: false })] })).toBeNull();
  });

  it('AC-4: every runner out of thread capacity is waiting_capacity (warning)', () => {
    const judgement = judge({ job: threadJob(), pool: [host({ threadCapacity: 1 })], loads: new Map([['r1', load({ threads: 1 })]]) });
    expect(judgement).toMatchObject({ verdict: 'waiting_capacity', severity: 'warning' });
    expect(judgement?.misfits).toEqual([{ runnerId: 'r1', runnerName: 'box-1', reason: 'thread_capacity' }]);
  });

  it('AC-5: every runner disabled is never (error)', () => {
    const judgement = judge({ pool: [runner({ enabled: false })] });
    expect(judgement).toMatchObject({ verdict: 'never', severity: 'error' });
    expect(judgement?.misfits).toEqual([{ runnerId: 'r1', runnerName: 'box-1', reason: 'disabled' }]);
  });

  it('AC-6: misfits are sorted by runner name, then runner id', () => {
    const judgement = judge({
      pool: [runner({ id: 'r9', name: 'zz-box', enabled: false }), runner({ id: 'r2', name: 'aa-box', enabled: false }), runner({ id: 'r1', name: 'aa-box', enabled: false })],
    });
    expect(judgement?.misfits.map((m) => [m.runnerName, m.runnerId])).toEqual([['aa-box', 'r1'], ['aa-box', 'r2'], ['zz-box', 'r9']]);
  });

  it('control: a THREAD job a host can take is not unplaceable', () => {
    expect(judge({ job: threadJob(), pool: [host()] })).toBeNull();
  });
});
