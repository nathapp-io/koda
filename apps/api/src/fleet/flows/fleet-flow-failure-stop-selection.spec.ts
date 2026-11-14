import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { awaitedFeatures, failureStopFeature } from './fleet-flow-feature-passes';

const feature = (position: number, state: string): FleetFlowFeatureRecord => ({
  id: `f${position}`, flowId: 'flow', position, feature: `feature-${position}`, specPath: 'spec.md',
  dependsOn: [], state, currentStep: null, prNumber: null,
});
const flow = (state: string, features: FleetFlowFeatureRecord[]): FleetFlowRecord => ({
  id: 'flow', projectId: 'p', repoId: 'r', threadId: null, entry: 'NAX', createdByType: 'USER',
  createdById: 'u', branch: 'b', specSha: 's', setSha: 's', pinnedRunnerId: null, reviewerRole: 'r',
  supervisorRole: 's', costCapUsd: '1', spentUsd: '0', state: state as FleetFlowRecord['state'],
  approvalMode: 'REQUEST', approverId: 'u', approvedAt: new Date(0), approvalRequestId: null,
  stopReason: null, stopDetail: null, endedAt: null, createdAt: new Date(0), updatedAt: new Date(0), features,
});

describe('flow failure feature selection', () => {
  it('AC-6: selects the first awaited feature in a waiting merge flow', () => {
    const merged = feature(0, 'MERGED');
    const awaited = feature(1, 'READY');
    const next = { ...feature(2, 'PENDING'), dependsOn: ['feature-1'] };
    expect(failureStopFeature(flow('WAITING_MERGE', [next, awaited, merged]))).toBe(awaited);
  });

  it('AC-7: falls back to the lowest-position feature when there is no active feature', () => {
    const first = feature(0, 'PENDING');
    expect(failureStopFeature(flow('RUNNING', [feature(1, 'READY'), first]))).toBe(first);
  });

  it('AC-9: exports awaited features in position order', () => {
    const first = feature(0, 'READY');
    const second = feature(1, 'READY');
    const next = { ...feature(2, 'PENDING'), dependsOn: ['feature-0', 'feature-1'] };
    expect(awaitedFeatures(flow('WAITING_MERGE', [next, second, first]))).toEqual([first, second]);
  });
});
