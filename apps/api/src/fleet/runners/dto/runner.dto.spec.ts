import { RunnerDto } from './runner.dto';
import type { RunnerRecord } from '../domain/runner.domain';

const now = new Date('2026-10-01T12:00:00.000Z');
const record = (over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  id: 'r1', name: 'box', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1, threadCapacity: 2, capabilities: { executors: ['host'] },
  daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-7', bootedAt: new Date('2026-10-01T11:00:00.000Z'),
  enabled: true, lastSeenAt: new Date(now.getTime() - 30_000), createdById: 'u1',
  createdAt: new Date('2026-09-30T00:00:00.000Z'), updatedAt: now, ...over,
});

describe('RunnerDto.from', () => {
  it('exposes bootId, bootedAt as ISO and online (#158)', () => {
    const dto = RunnerDto.from(record(), { now, offlineSec: 90 });
    expect(dto).toEqual(expect.objectContaining({ bootId: 'boot-7', bootedAt: '2026-10-01T11:00:00.000Z', online: true }));
  });

  it('exposes the server-set threadCapacity (US-002 AC4)', () => {
    expect(RunnerDto.from(record({ threadCapacity: 2 }), { now, offlineSec: 90 }).threadCapacity).toBe(2);
  });

  it('keeps bootedAt null for a runner that has not booted since the migration', () => {
    expect(RunnerDto.from(record({ bootedAt: null }), { now, offlineSec: 90 }).bootedAt).toBeNull();
  });

  it('reports offline past the threshold, independent of enabled', () => {
    const stale = record({ lastSeenAt: new Date(now.getTime() - 91_000), enabled: true });
    const disabledButSyncing = record({ enabled: false });
    expect(RunnerDto.from(stale, { now, offlineSec: 90 }).online).toBe(false);
    expect(RunnerDto.from(disabledButSyncing, { now, offlineSec: 90 }).online).toBe(true);
  });

  it('never exposes createdById or the key hash', () => {
    const dto = RunnerDto.from(record(), { now, offlineSec: 90 }) as unknown as Record<string, unknown>;
    expect(dto).not.toHaveProperty('createdById');
    expect(dto).not.toHaveProperty('apiKeyHash');
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });
});
