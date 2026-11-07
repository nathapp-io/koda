import type { FleetJobRecord } from '../../jobs/domain/fleet-job.domain';
import type { PrincipalRef } from '../../../permissions/permissions.types';
import type { FlowStep } from '../flow-steps';
import type { FlowQuestion } from '../flow-calls';

export const FLEET_FLOW_STEP_REPOSITORY = Symbol('FLEET_FLOW_STEP_REPOSITORY');

export interface AdvanceableFlow {
  id: string;
  createdByType: 'USER' | 'AGENT';
  createdById: string;
}

/** Persistence reads used by the single-feature flow advancement engine. */
export interface CreatorAccess {
  exists: boolean;
  disabled: boolean;
}

/**
 * A flow's latest job together with the ingest status of that job's own lease, read in one statement.
 * A RUN's `resultPrUrl` and the settled mark of its attempt commit in the same transaction
 * (`BundleIngestService.write`), so the two facts have to come from one snapshot: read separately, the
 * decision can pair an old row with a new status and stop a flow whose PR was just recorded.
 */
export interface LatestFlowJob {
  job: FleetJobRecord;
  ingestSettled: boolean;
}

export interface MarkFlowStepData {
  flowState: string;
  prNumber?: number;
}

export interface IFleetFlowStepRepository {
  setSpent(flowId: string, spentUsd: string): Promise<void>;
  creatorAccess(ref: PrincipalRef): Promise<CreatorAccess>;
  markStep(flowId: string, featureId: string, step: FlowStep, data: MarkFlowStepData): Promise<void>;
  complete(flowId: string, now: Date): Promise<void>;
  listAdvanceable(limit: number, afterId: string | null): Promise<AdvanceableFlow[]>;
  latestJob(flowId: string): Promise<FleetJobRecord | null>;
  /** The flow's latest job and the ingest status of its own lease, from one statement (see `LatestFlowJob`). */
  latestJobWithIngest(flowId: string): Promise<LatestFlowJob | null>;
  latestJobForStep(flowId: string, step: FlowStep): Promise<FleetJobRecord | null>;
  countJobsForStepSince(flowId: string, step: FlowStep, since: Date): Promise<number>;
  projectSlug(projectId: string): Promise<string | null>;
  /** Adopt the PLAN output branch before applying PRD calls or re-asking that branch's head. */
  setBranch(flowId: string, branch: string): Promise<void>;
  recordCalls(flowId: string, featureId: string, jobId: string, specSha: string): Promise<void>;
  /**
   * Puts the feature and its flow into `WAITING_ANSWER` for the review job `jobId`: the questions are
   * stored and the answers of an earlier review are cleared, so a wait never answers a later review.
   */
  setWaiting(flowId: string, featureId: string, input: { jobId: string; questions: FlowQuestion[] }): Promise<void>;
  setTicket(flowId: string, ticketId: string): Promise<boolean>;
  sumCost(flowId: string): Promise<string>;
  ingestSettled(jobId: string, leaseEpoch: number): Promise<boolean>;
}
