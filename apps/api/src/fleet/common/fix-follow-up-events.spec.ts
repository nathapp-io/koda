import { buildFixFollowUpPayload, parseFixFollowUpPayload } from './fix-follow-up-events';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';

const job = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'j1', projectId: 'p1', repoId: 'r1', requestedById: 'u1', requestedByType: 'USER',
  leaseEpoch: 2, profiles: ['balanced', 'security'], maxCostUsd: '1.2500',
  ...over,
} as FleetJobRecord);

describe('fix follow-up events', () => {
  it('builds and parses the complete snapshot payload', () => {
    const payload = buildFixFollowUpPayload(job(), 22, 'a'.repeat(40));
    expect(payload).toEqual({
      jobId: 'j1', leaseEpoch: 2, projectId: 'p1', repoId: 'r1', prNumber: 22,
      headSha: 'a'.repeat(40), requestedById: 'u1', requestedByType: 'USER',
      profiles: ['balanced', 'security'], maxCostUsd: '1.2500',
    });
    expect(parseFixFollowUpPayload(payload)).toEqual(payload);
  });

  it.each([
    ['requestedByType', 'SYSTEM'],
    ['prNumber', 0],
    ['profiles', [1]],
    ['maxCostUsd', 1],
  ])('rejects invalid %s', (_field, value) => {
    const payload = buildFixFollowUpPayload(job(), 22, 'a'.repeat(40));
    expect(parseFixFollowUpPayload({ ...payload, [_field]: value })).toBeNull();
  });

  it('rejects a missing required field and malformed records', () => {
    const payload = buildFixFollowUpPayload(job(), 22, 'a'.repeat(40));
    const { jobId: _jobId, ...missingJobId } = payload;
    expect(parseFixFollowUpPayload(missingJobId)).toBeNull();
    expect(parseFixFollowUpPayload(null)).toBeNull();
  });
});
