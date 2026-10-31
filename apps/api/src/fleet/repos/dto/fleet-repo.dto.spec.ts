import { FleetRepoDto } from './fleet-repo.dto';
import type { FleetRepoRecord } from '../domain/fleet-repo.domain';

describe('FleetRepoDto auto-review fields', () => {
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: true,
    autoReviewProfiles: ['review'], autoReviewMaxCostUsd: '2.5', autoReviewEnabledById: 'u',
    autoReviewEnabledByType: 'USER', autoReviewEnabledAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
  });

  it('serializes all auto-review properties including fixed decimal and ISO date', () => {
    expect(FleetRepoDto.from(record())).toMatchObject({
      autoReview: true, autoReviewProfiles: ['review'], autoReviewMaxCostUsd: '2.5000',
      autoReviewEnabledById: 'u', autoReviewEnabledByType: 'USER', autoReviewEnabledAt: '2026-11-01T00:00:00.000Z',
    });
  });
});
