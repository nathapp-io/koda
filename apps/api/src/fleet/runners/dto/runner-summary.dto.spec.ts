import { RunnerSummaryDto } from './runner-summary.dto';
import type { RunnerRecord } from '../domain/runner.domain';

const now = new Date('2026-10-01T12:00:00.000Z');
const record = (capabilities: unknown, over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], capacity: 2, threadCapacity: 2, capabilities,
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', bootedAt: null, enabled: true,
  lastSeenAt: now, createdById: 'u1', createdAt: now, updatedAt: now, ...over,
});

describe('RunnerSummaryDto.from', () => {
  it('lists machine profile names sorted, and nothing else from the capability report', () => {
    const dto = RunnerSummaryDto.from(record({ profiles: { zeta: {}, alpha: {} }, credentials: [{ providerId: 'x' }] }), { now, offlineSec: 90 });
    expect(dto).toEqual({ id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, online: true, profiles: ['alpha', 'zeta'], threadBackends: { native: [], acp: [] }, projectThreads: false });
  });

  it('answers no profiles for a malformed or empty report instead of throwing', () => {
    for (const caps of [null, {}, { profiles: null }, { profiles: ['a'] }, 'x']) {
      expect(RunnerSummaryDto.from(record(caps), { now, offlineSec: 90 }).profiles).toEqual([]);
    }
  });

  it('US-001 AC11: reads validated threadBackends from a protocol v4 report', () => {
    const dto = RunnerSummaryDto.from(record({ threadBackends: { native: ['m1', 'm2'], acp: [] } }, { protocolVersion: 4 }), { now, offlineSec: 90 });
    expect(dto.threadBackends).toEqual({ native: ['m1', 'm2'], acp: [] });
  });

  it('US-001 AC12: hides stored threadBackends below the protocol floor', () => {
    const dto = RunnerSummaryDto.from(record({ threadBackends: { native: ['m1', 'm2'], acp: [] } }, { protocolVersion: 3 }), { now, offlineSec: 90 });
    expect(dto.threadBackends).toEqual({ native: [], acp: [] });
  });

  it('US-001 AC13: drops threadBackends whose native list holds non-strings', () => {
    const dto = RunnerSummaryDto.from(record({ threadBackends: { native: [1], acp: [] } }, { protocolVersion: 4 }), { now, offlineSec: 90 });
    expect(dto.threadBackends).toEqual({ native: [], acp: [] });
  });

  it('US-001 AC5: reports projectThreads for a protocol v4 runner whose report advertises it', () => {
    const dto = RunnerSummaryDto.from(record({ projectThreads: true }, { protocolVersion: 4 }), { now, offlineSec: 90 });
    expect(dto.projectThreads).toBe(true);
  });

  it('US-001 AC6: reports no projectThreads for a protocol v4 runner whose report omits it', () => {
    const dto = RunnerSummaryDto.from(record({ profiles: {} }, { protocolVersion: 4 }), { now, offlineSec: 90 });
    expect(dto.projectThreads).toBe(false);
  });

  it('US-001 AC7: hides stored projectThreads below the protocol floor', () => {
    const dto = RunnerSummaryDto.from(record({ projectThreads: true }, { protocolVersion: 3 }), { now, offlineSec: 90 });
    expect(dto.projectThreads).toBe(false);
  });

  it('US-001 AC7: answers no projectThreads for a malformed report instead of throwing', () => {
    for (const caps of [null, {}, { projectThreads: 'yes' }, { projectThreads: 1 }]) {
      expect(RunnerSummaryDto.from(record(caps, { protocolVersion: 4 }), { now, offlineSec: 90 }).projectThreads).toBe(false);
    }
  });

  it('US-001: exposes exactly the summary keys the project runner list contract pins', () => {
    const dto = RunnerSummaryDto.from(record({ profiles: {} }), { now, offlineSec: 90 });
    expect(Object.keys(dto).sort())
      .toEqual(['arch', 'enabled', 'id', 'labels', 'name', 'online', 'os', 'profiles', 'projectThreads', 'threadBackends']);
  });
});
