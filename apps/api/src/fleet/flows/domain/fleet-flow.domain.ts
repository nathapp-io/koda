import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { HandoffRecordFile } from '@nathapp/fleet-protocol';
import type { FleetFlowState } from '../flow-states';
import type { FlowAnswer, FlowQuestion } from '../flow-calls';

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
  branch?: string | null;
  dependsOn: string[];
  state: string;
  currentStep: string | null;
  prNumber: number | null;
  callsJobId?: string | null;
  rulingsJobId?: string | null;
  prdEditsJobId?: string | null;
  /** The review job the stored questions and answers belong to: a later review replaces them. */
  questionsJobId?: string | null;
  questions?: FlowQuestion[] | null;
  answers?: FlowAnswer[] | null;
  answeredById?: string | null;
  answeredAt?: Date | null;
  /**
   * US-003: the feature was handed over from a chat run. The record itself is never read with the
   * flow: the repository omits it, so only the RUN dispatch reads it (`findHandoffRecord`).
   */
  handoff?: boolean;
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
  setSha: string;
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
  stopDetail?: string | null;
  ticketId?: string | null;
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
  /**
   * US-003: the record a handoff flow carries. The repository writes it onto the flow's first
   * feature (`handoff: true`); the feature inputs never carry it.
   */
  handoff?: { record: HandoffRecordFile[] };
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
  findPage(filters: { projectId: string; threadId?: string }, page: IPageOption): Promise<IPageResult<FleetFlowRecord>>;
  findLiveForThread(threadId: string): Promise<FleetFlowRecord | null>;
  findLiveForSpec(repoId: string, branch: string, specSha: string): Promise<FleetFlowRecord | null>;
  /**
   * US-003: the live flow on a repo and branch, whatever its spec sha. A handoff flow is found by
   * its branch alone: the sha it was approved with is the chat run's head, not a spec sha.
   */
  findLiveForBranch(repoId: string, branch: string): Promise<FleetFlowRecord | null>;
  /**
   * US-003: the record a handoff feature carries, or null when the feature has none (or does not
   * exist). The only read of the stored record: the RUN dispatch needs it.
   */
  findHandoffRecord(featureId: string): Promise<HandoffRecordFile[] | null>;
  /**
   * PENDING -> APPROVED. A request-approval records the request it was decided through; a flow
   * started by the thread's covering tick has no request, so `approvalRequestId` stays null.
   */
  approve(id: string, data: { mode: FleetFlowApprovalMode; approverId: string; approvedAt: Date; approvalRequestId: string | null }): Promise<FleetFlowRecord>;
  /** Stores the `fleet.flow.start` request opened for a freshly inserted PENDING flow. */
  setApprovalRequestId(id: string, approvalRequestId: string): Promise<FleetFlowRecord>;
  reask(id: string, data: { specSha: string; approvalRequestId: string }): Promise<FleetFlowRecord>;
  updateSha(id: string, specSha: string): Promise<FleetFlowRecord>;
  stop(id: string, reason: string, now: Date, detail?: string | null): Promise<FleetFlowRecord>;
  /**
   * Stores the answers a human gave to the review the feature waits on, and resumes the flow. The
   * answers stay bound to the review job that asked the questions (`questionsJobId`).
   */
  recordAnswers(
    flowId: string,
    featureId: string,
    input: { answers: FlowAnswer[]; userId: string; at: Date },
  ): Promise<FleetFlowRecord>;
}
