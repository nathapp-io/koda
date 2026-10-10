import type { RunnerCapabilities } from '../../../src/fleet/common/protocol';
import {
  EMPTY_LOAD,
  firstMisfit,
  toLoads,
  type PlacementJob,
  type PlacementRunner,
  type RunnerLoad,
} from '../../../src/fleet/jobs/placement-rules';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const capabilities = (overrides: Record<string, unknown> = {}): RunnerCapabilities => ({
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: NOW.toISOString() },
  profiles: {},
  credentials: [],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
  ...overrides,
} as RunnerCapabilities);
const runner = (overrides: Record<string, unknown> = {}): PlacementRunner => ({
  id: 'r1', name: 'runner', enabled: true, lastSeenAt: new Date(NOW.getTime() - 1_000),
  labels: [], capacity: 1, capabilities: capabilities(), ...overrides,
} as PlacementRunner);
const job = (overrides: Record<string, unknown> = {}): PlacementJob => ({
  command: 'RUN', repoId: 'rA', provider: 'github', profiles: [], selectorLabels: [], pinnedRunnerId: null, bashMode: 'raw', ...overrides,
} as PlacementJob);
const threadJob = (overrides: Record<string, unknown> = {}) => job({
  command: 'THREAD', thread: { backend: { kind: 'native' }, enabled: true }, ...overrides,
});
const load = (overrides: Record<string, unknown> = {}): RunnerLoad => ({ active: 0, repoIds: new Set<string>(), ...overrides } as RunnerLoad);
const misfit = (j: PlacementJob, r: PlacementRunner, l = EMPTY_LOAD) => firstMisfit(j, r, l, NOW, 90);
const threadCaps = (threadBackends: { native: string[]; acp: string[] }) => capabilities({ threadBackends });

describe('US-006 THREAD placement rules', () => {
  it('US-006 AC1: counts held THREAD jobs only in the thread load', () => {
    const loads = toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD' } as { runnerId: string; repoId: string }]);
    expect(loads.get('r1')).toEqual({ active: 0, repoIds: new Set(), threads: 1 });
  });

  it('US-006 AC2: a THREAD job does not block a RUN job in the same repository', () => {
    const loads = toLoads([{ runnerId: 'r1', repoId: 'rA', command: 'THREAD' } as { runnerId: string; repoId: string }]);
    expect(misfit(job(), runner(), loads.get('r1') ?? EMPTY_LOAD)).toBeNull();
  });

  it('US-006 AC3: a fitting THREAD job ignores finite capacity and same-repository load', () => {
    const r = runner({ protocolVersion: 4, threadCapacity: 2, capabilities: threadCaps({ native: ['m1'], acp: [] }) });
    expect(misfit(threadJob(), r, load({ active: 1, repoIds: new Set(['rA']), threads: 0 }))).toBeNull();
  });

  it('US-006 AC4: rejects a THREAD job after all thread slots are occupied', () => {
    const r = runner({ protocolVersion: 4, threadCapacity: 2, capabilities: threadCaps({ native: ['m1'], acp: [] }) });
    expect(misfit(threadJob(), r, load({ threads: 2 }))).toBe('thread_capacity');
  });

  it('US-006 AC5: rejects a native model the runner does not support', () => {
    const r = runner({ protocolVersion: 4, threadCapacity: 2, capabilities: threadCaps({ native: ['m1'], acp: [] }) });
    expect(misfit(threadJob({ thread: { backend: { kind: 'native', model: 'm2' }, enabled: true } }), r)).toBe('thread_backend');
  });

  it('US-006 AC6: rejects an ACP agent absent from runner capabilities', () => {
    const r = runner({ protocolVersion: 4, threadCapacity: 2, capabilities: threadCaps({ native: ['m1'], acp: [] }) });
    expect(misfit(threadJob({ thread: { backend: { kind: 'acp', agent: 'claude' }, enabled: true } }), r)).toBe('thread_backend');
  });

  it('US-006 AC7: waits for protocol v4 before placing THREAD jobs', () => {
    const r = runner({ protocolVersion: 3, threadCapacity: 2, capabilities: threadCaps({ native: ['m1'], acp: [] }) });
    expect(misfit(threadJob(), r)).toBe('protocol');
  });

  it('US-006 AC8: reports threads_disabled when thread placement is disabled', () => {
    const r = runner({ protocolVersion: 4, threadCapacity: 2, capabilities: threadCaps({ native: ['m1'], acp: [] }) });
    expect(misfit(threadJob({ thread: { backend: { kind: 'native' }, enabled: false } }), r)).toBe('threads_disabled');
  });

  it('US-006 AC9: THREAD placement skips unrelated interaction and sandbox restrictions', () => {
    const r = runner({
      protocolVersion: 4, threadCapacity: 2,
      capabilities: threadCaps({ native: ['m1'], acp: [] }),
    });
    (r.capabilities as unknown as { interaction: { ok: boolean } }).interaction = { ok: false };
    (r.capabilities as unknown as { sandbox: { available: boolean; probedAt: string } }).sandbox = { available: false, probedAt: 'x' };
    expect(misfit(threadJob(), r)).toBeNull();
  });
});
