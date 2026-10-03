import { normalizeDispatch } from '../jobs/dispatch-input';
import { toDispatchDto } from './schedule-template';

describe('toDispatchDto', () => {
  it('is always a RUN of the fixed feature, and passes the dispatch rules', () => {
    const dto = toDispatchDto({
      repoId: 'r1', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: '5.5000', selectorLabels: ['linux'], pinnedRunnerId: null,
      bashMode: 'raw', approvalTimeoutSec: 600,
    });
    expect(dto).toEqual({ repoId: 'r1', command: 'RUN', feature: 'login', ref: 'main', profiles: ['fast'], maxCostUsd: 5.5, selectorLabels: ['linux'], bashMode: 'raw', approvalTimeoutSec: 600 });
    expect(normalizeDispatch(dto, 'trunk')).toEqual(expect.objectContaining({ command: 'RUN', ref: 'main', maxCostUsd: '5.5', pinnedRunnerId: null }));
  });

  it('carries the pinned runner when there is one, and copies the arrays', () => {
    const profiles = ['fast'];
    const dto = toDispatchDto({ repoId: 'r1', feature: 'f', ref: 'main', profiles, maxCostUsd: '1', selectorLabels: [], pinnedRunnerId: 'run-1', bashMode: 'raw', approvalTimeoutSec: 600 });
    expect(dto.pinnedRunnerId).toBe('run-1');
    expect(dto.profiles).not.toBe(profiles);
  });

  it('copies bashMode and approvalTimeoutSec into the dispatch (S1.5 §1.6)', () => {
    const template = { repoId: 'r1', feature: 'f', ref: 'main', profiles: [], maxCostUsd: '5', selectorLabels: [], pinnedRunnerId: null,
      bashMode: 'escalate' as const, approvalTimeoutSec: 300 };
    expect(toDispatchDto(template)).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 300 }));
  });
});
