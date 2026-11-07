import type { FleetJobRecord } from '../../jobs/domain/fleet-job.domain';
import type { FlowStep } from '../flow-steps';

export const FLEET_FLOW_STEP_REPOSITORY = Symbol('FLEET_FLOW_STEP_REPOSITORY');

export interface AdvanceableFlow {
  id: string;
  createdByType: 'USER' | 'AGENT';
  createdById: string;
}

/** Persistence reads used by the single-feature flow advancement engine. */
export interface IFleetFlowStepRepository {
  listAdvanceable(limit: number, afterId: string | null): Promise<AdvanceableFlow[]>;
  latestJob(flowId: string): Promise<FleetJobRecord | null>;
  latestJobForStep(flowId: string, step: FlowStep): Promise<FleetJobRecord | null>;
  sumCost(flowId: string): Promise<string>;
  ingestSettled(jobId: string, leaseEpoch: number): Promise<boolean>;
}
