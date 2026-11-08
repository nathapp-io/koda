import { FleetFlowAdvanceService } from './fleet-flow-advance.service';
import { buildStepDispatch } from './flow-step-dispatch';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import type { FlowStepAction } from './flow-step-decision';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

describe('FleetFlowAdvanceService PRD edit dispatch', () => {
  it('AC-7: sends the PRD_REVIEW body with edits enabled for a NAX flow', async () => {
    const flow = {
      id: 'flow-1', projectId: 'project-1', repoId: 'repo-1', entry: 'NAX', branch: 'feature/one',
      specSha: 'spec-sha', reviewerRole: 'reviewer', pinnedRunnerId: null, createdById: 'user-1',
      features: [{ feature: 'one', specPath: '.nax/features/one/spec.md' }],
    } as unknown as FleetFlowRecord;
    const feature = flow.features[0];
    const plan = { resultSha: 'plan-sha', resultBranch: 'plan/branch' } as FleetJobRecord;
    const dispatch = vi.fn(async () => ({ job: { id: 'next-job' } }));
    const service = new FleetFlowAdvanceService(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      { dispatch } as never, {} as never, {} as never, {} as never, {} as never, testFleetConfig(),
      {} as never, {} as never, {} as never,
    );
    const invoke = service as unknown as {
      dispatchStep(pass: {
        flow: FleetFlowRecord;
        action: FlowStepAction;
        plan: FleetJobRecord;
        remainingCapUsd: string;
      }): Promise<string>;
    };

    await expect(invoke.dispatchStep({
      flow,
      action: { kind: 'dispatch', step: 'PRD_REVIEW' },
      plan,
      remainingCapUsd: '10.0000',
    })).resolves.toBe('next-job');

    expect(dispatch).toHaveBeenCalledWith('user-1', 'project-1', buildStepDispatch({
      flow, feature, step: 'PRD_REVIEW', remainingCapUsd: '10.0000', reviewAgent: 'Explore', plan, prdEdits: true,
    }), expect.any(Object));
  });
});
