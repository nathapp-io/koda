import type { ApprovalRequestSummary } from '~/lib/approval-requests'

/** Fleet flow DTOs are hand-written mirrors of the API wire contracts. */
export interface FleetFlowCreatorDto {
  type: 'USER' | 'AGENT'
  id: string
}

export interface FleetFlowRolesDto {
  reviewer: string
  supervisor: string
}

export interface FleetFlowApprovalDto {
  mode: 'REQUEST' | 'PRE_APPROVED'
  approverId: string | null
  approvedAt: string | null
  approvalRequestId: string | null
}

export interface FleetFlowQuestionDto {
  id: string
  question: string
}

export interface FleetFlowAnswerDto {
  id: string
  answer: string
}

export interface FleetFlowFeatureDto {
  feature: string
  specPath: string
  branch: string | null
  dependsOn: string[]
  state: string
  currentStep: string | null
  prNumber: number | null
  questionsJobId: string | null
  questions: FleetFlowQuestionDto[] | null
  answers: FleetFlowAnswerDto[] | null
  answeredAt: string | null
}

export interface FleetFlowDto {
  id: string
  projectId: string
  repoId: string
  threadId: string | null
  entry: 'THREAD' | 'NAX'
  createdBy: FleetFlowCreatorDto
  branch: string
  specSha: string
  pinnedRunnerId: string | null
  roles: FleetFlowRolesDto
  costCapUsd: string
  spentUsd: string
  state: string
  approval: FleetFlowApprovalDto | null
  stopReason: string | null
  stopDetail: string | null
  endedAt: string | null
  createdAt: string
  features: FleetFlowFeatureDto[]
  url: string
}

export interface FleetFlowPage {
  records: FleetFlowDto[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

export interface FlowRepo {
  provider: string
  owner: string
  name: string
}

export interface FleetFlowJobDto {
  id: string
  feature: string | null
  step: string | null
  command: string
  state: string
  costUsd: string
  queuedAt: string
  finishedAt: string | null
}

export interface FleetFlowOverviewDto {
  repo: FlowRepo | null
  ticketRef: string | null
  jobs: FleetFlowJobDto[]
  truncated: boolean
  unknownCostCount: number
}

export const LIVE_FLOW_STATES: readonly string[] = [
  'PENDING', 'APPROVED', 'RUNNING', 'WAITING_MERGE', 'WAITING_ANSWER',
]

export function isLiveFlow(state: string): boolean {
  return LIVE_FLOW_STATES.includes(state)
}

export function flowTitle(flow: { features: readonly { feature: string }[] }): string | null {
  return flow.features.length ? flow.features.map(({ feature }) => feature).join(', ') : null
}

const FLOW_STATE_KEYS: Readonly<Record<string, string>> = {
  PENDING: 'fleet.flows.state.PENDING',
  APPROVED: 'fleet.flows.state.APPROVED',
  RUNNING: 'fleet.flows.state.RUNNING',
  WAITING_MERGE: 'fleet.flows.state.WAITING_MERGE',
  WAITING_ANSWER: 'fleet.flows.state.WAITING_ANSWER',
  COMPLETED: 'fleet.flows.state.COMPLETED',
  STOPPED: 'fleet.flows.state.STOPPED',
}

const FEATURE_STATE_KEYS: Readonly<Record<string, string>> = {
  PENDING: 'fleet.flows.featureState.PENDING',
  RUNNING: 'fleet.flows.featureState.RUNNING',
  WAITING_ANSWER: 'fleet.flows.featureState.WAITING_ANSWER',
  READY: 'fleet.flows.featureState.READY',
  MERGED: 'fleet.flows.featureState.MERGED',
  COMPLETED: 'fleet.flows.featureState.COMPLETED',
  STOPPED: 'fleet.flows.featureState.STOPPED',
}

const FLOW_STEP_KEYS: Readonly<Record<string, string>> = {
  SPEC_REVIEW: 'fleet.flows.step.SPEC_REVIEW',
  PLAN: 'fleet.flows.step.PLAN',
  PRD_REVIEW: 'fleet.flows.step.PRD_REVIEW',
  RUN: 'fleet.flows.step.RUN',
  REVIEW: 'fleet.flows.step.REVIEW',
  RULE: 'fleet.flows.step.RULE',
  FIX: 'fleet.flows.step.FIX',
}

const mappedKey = (map: Readonly<Record<string, string>>, value: string | null): string | null =>
  value === null || !Object.hasOwn(map, value) ? null : map[value]

export const flowStateKey = (state: string): string | null => mappedKey(FLOW_STATE_KEYS, state)
export const featureStateKey = (state: string): string | null => mappedKey(FEATURE_STATE_KEYS, state)
export const flowStepKey = (step: string | null): string | null => mappedKey(FLOW_STEP_KEYS, step)

export function featureBranch(flow: FleetFlowDto, feature: FleetFlowFeatureDto): string {
  return feature.branch ?? flow.branch
}

export function prUrl(repo: FlowRepo | null, prNumber: number | null): string | null {
  if (repo === null || repo.provider !== 'github' || prNumber === null) return null
  return `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}`
}

export function jobsByFeature(
  jobs: FleetFlowJobDto[],
  features: FleetFlowFeatureDto[],
): { byFeature: Map<string, FleetFlowJobDto[]>; flowJobs: FleetFlowJobDto[] } {
  const byFeature = new Map<string, FleetFlowJobDto[]>()
  for (const feature of features) {
    if (!byFeature.has(feature.feature)) byFeature.set(feature.feature, [])
  }

  const flowJobs: FleetFlowJobDto[] = []
  for (const job of jobs) {
    if (job.feature === null) {
      flowJobs.push(job)
      continue
    }
    const featureJobs = byFeature.get(job.feature)
    if (featureJobs !== undefined) featureJobs.push(job)
  }
  return { byFeature, flowJobs }
}

export function openQuestions(feature: FleetFlowFeatureDto): FleetFlowQuestionDto[] {
  return feature.answeredAt === null ? feature.questions ?? [] : []
}

export function isPendingFlowAnswer(data: unknown): data is ApprovalRequestSummary {
  return typeof data === 'object' && data !== null && 'permissionKey' in data
}
