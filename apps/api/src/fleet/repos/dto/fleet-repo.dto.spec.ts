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

describe('FleetRepoDto fix-checks field (US-001)', () => {
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  it('AC-13: a record without the field serializes as false', () => {
    expect(FleetRepoDto.from(record()).fixTrustDetectedChecks).toBe(false);
  });

  it('AC-13: a record with the field true serializes as true', () => {
    expect(FleetRepoDto.from(record({ fixTrustDetectedChecks: true })).fixTrustDetectedChecks).toBe(true);
  });
});

describe('FleetRepoDto fix-unprotected field', () => {
  const record = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
    id: 'r', projectId: 'p', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  it('a record without the field serializes as false', () => {
    expect(FleetRepoDto.from(record()).fixAllowUnprotected).toBe(false);
  });

  it('a record with the field true serializes as true', () => {
    expect(FleetRepoDto.from(record({ fixAllowUnprotected: true })).fixAllowUnprotected).toBe(true);
  });
});
