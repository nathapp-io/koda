import { RunnerSummaryDto } from './runner-summary.dto';
import type { RunnerRecord } from '../domain/runner.domain';

const now = new Date('2026-10-01T12:00:00.000Z');
const record = (capabilities: unknown, over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], capacity: 2, capabilities,
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'b', bootedAt: null, enabled: true,
  lastSeenAt: now, createdById: 'u1', createdAt: now, updatedAt: now, ...over,
});

describe('RunnerSummaryDto.from', () => {
  it('lists machine profile names sorted, and nothing else from the capability report', () => {
    const dto = RunnerSummaryDto.from(record({ profiles: { zeta: {}, alpha: {} }, credentials: [{ providerId: 'x' }] }), { now, offlineSec: 90 });
    expect(dto).toEqual({ id: 'r1', name: 'box', os: 'darwin', arch: 'arm64', labels: ['mac'], enabled: true, online: true, profiles: ['alpha', 'zeta'] });
  });

  it('answers no profiles for a malformed or empty report instead of throwing', () => {
    for (const caps of [null, {}, { profiles: null }, { profiles: ['a'] }, 'x']) {
      expect(RunnerSummaryDto.from(record(caps), { now, offlineSec: 90 }).profiles).toEqual([]);
    }
  });
});
