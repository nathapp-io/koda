import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetFlowState } from '../flow-states';

export const FLEET_FLOW_REPOSITORY = Symbol('FLEET_FLOW_REPOSITORY');

export type FleetFlowEntry = 'THREAD' | 'NAX';
export type FleetFlowCreatorType = 'USER' | 'AGENT';
export type FleetFlowApprovalMode = 'REQUEST' | 'PRE_APPROVED';

export interface FleetFlowFeatureRecord {
  id: string;
  flowId: string;
  position: number;
  feature: string;
  specPath: string;
  dependsOn: string[];
  state: string;
  currentStep: string | null;
  prNumber: number | null;
}

export interface FleetFlowRecord {
  id: string;
  projectId: string;
  repoId: string;
  threadId: string | null;
  entry: FleetFlowEntry;
  createdByType: FleetFlowCreatorType;
  createdById: string;
  branch: string;
  specSha: string;
  pinnedRunnerId: string | null;
  reviewerRole: string;
  supervisorRole: string;
  costCapUsd: string;
  spentUsd: string;
  state: FleetFlowState;
  approvalMode: FleetFlowApprovalMode | null;
  approverId: string | null;
  approvedAt: Date | null;
  approvalRequestId: string | null;
  stopReason: string | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  features: FleetFlowFeatureRecord[];
}

export interface CreateFleetFlow {
  projectId: string;
  repoId: string;
  threadId?: string | null;
  entry: FleetFlowEntry;
  createdByType: FleetFlowCreatorType;
  createdById: string;
  branch: string;
  specSha: string;
  pinnedRunnerId?: string | null;
  reviewerRole: string;
  supervisorRole: string;
  costCapUsd: string;
  approvalMode?: FleetFlowApprovalMode | null;
  features: Array<Pick<FleetFlowFeatureRecord, 'feature' | 'specPath' | 'dependsOn'>>;
}

export class FlowTransitionError extends Error {
  constructor(readonly flowId: string, readonly from: string, readonly to: string) {
    super(`Cannot transition flow ${flowId} from ${from} to ${to}`);
    this.name = 'FlowTransitionError';
  }
}

export interface IFleetFlowRepository {
  create(data: CreateFleetFlow): Promise<FleetFlowRecord>;
  findById(id: string): Promise<FleetFlowRecord | null>;
  lockById(id: string): Promise<FleetFlowRecord | null>;
  findPage(filters: { projectId: string }, page: IPageOption): Promise<IPageResult<FleetFlowRecord>>;
  findLiveForThread(threadId: string): Promise<FleetFlowRecord | null>;
  findLiveForSpec(repoId: string, branch: string, specSha: string): Promise<FleetFlowRecord | null>;
  /**
   * PENDING -> APPROVED. A request-approval records the request it was decided through; a flow
   * started by the thread's covering tick has no request, so `approvalRequestId` stays null.
   */
  approve(id: string, data: { mode: FleetFlowApprovalMode; approverId: string; approvedAt: Date; approvalRequestId: string | null }): Promise<FleetFlowRecord>;
  /** Stores the `fleet.flow.start` request opened for a freshly inserted PENDING flow. */
  setApprovalRequestId(id: string, approvalRequestId: string): Promise<FleetFlowRecord>;
  reask(id: string, data: { specSha: string; approvalRequestId: string }): Promise<FleetFlowRecord>;
  updateSha(id: string, specSha: string): Promise<FleetFlowRecord>;
  stop(id: string, reason: string, now: Date): Promise<FleetFlowRecord>;
}
