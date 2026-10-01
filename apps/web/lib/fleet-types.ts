/**
 * Fleet S1 wire types for the web (hand-written: the web has no generated client).
 * Shapes follow docs/superpowers/plans/2026-10-01-fleet-s1-slice-4-overview.md.
 */

import type { FleetJobState } from '~/lib/project-event-stream'

/** Page envelope of every fleet list (`toPageResult`). */
export interface FleetPage<T> {
  records: T[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

/** Runner and repo lists ask for one page of this size (plan D125). */
export const FLEET_LIST_SIZE = 100

export type FleetProtocol = 'acp' | 'native'

export interface FleetProfileNeeds {
  protocol: FleetProtocol
  providers: string[]
  sandbox: boolean
}

export interface FleetCredentialStored {
  kind: 'api-key' | 'oauth'
  expires?: string
  expired: boolean
}

export interface FleetCredential {
  providerId: string
  available: boolean
  stored: FleetCredentialStored | null
  exec?: 'served' | 'declined' | 'error'
  ambient: boolean
}

/** `RunnerCapabilities` from packages/fleet-protocol; on the wire it is an untyped object. */
export interface FleetCapabilities {
  nax: { version: string; protocols: FleetProtocol[] }
  sandbox: { available: boolean; probedAt: string; error?: string }
  profiles: Record<string, FleetProfileNeeds>
  credentials: FleetCredential[]
  tools: { git: boolean; gh: boolean; glab: boolean }
  executors: string[]
}

export interface FleetRunner {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  capacity: number
  capabilities: Record<string, unknown>
  daemonVersion: string
  protocolVersion: number
  enabled: boolean
  lastSeenAt: string
  createdAt: string
  bootId: string
  bootedAt: string | null
  online: boolean
}

export interface FleetRunnerPatch {
  enabled?: boolean
  labels?: string[]
  capacity?: number
}

export interface FleetEnrollment {
  id: string
  labels: string[]
  expiresAt: string
  usedAt: string | null
  runnerId: string | null
  createdById: string
  createdAt: string
}

export interface FleetEnrollmentCreated extends FleetEnrollment {
  token: string
}

/** Project-member view of a runner (GET /projects/:slug/fleet/runners). */
export interface FleetRunnerSummary {
  id: string
  name: string
  os: string
  arch: string
  labels: string[]
  enabled: boolean
  online: boolean
  profiles: string[]
}

export type FleetProvider = 'github' | 'gitlab'

export interface FleetRepo {
  id: string
  projectId: string
  provider: FleetProvider
  owner: string
  name: string
  defaultBranch: string
  githubInstallationId: string | null
  createdAt: string
}

export interface NewFleetRepo {
  projectSlug: string
  provider: FleetProvider
  owner: string
  name: string
}

export interface FleetRepoCheck {
  repoId: string
  reachable: boolean
  reason: string | null
  checkedAt: string
}

export type { FleetJobState }

export type MisfitReason =
  | 'disabled' | 'offline' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity'

export interface FleetJobDto {
  id: string
  projectId: string
  repoId: string
  ref: string
  command: 'RUN' | 'PLAN'
  feature: string
  planFrom: string | null
  profiles: string[]
  maxCostUsd: string
  bashMode: string
  selectorLabels: string[]
  pinnedRunnerId: string | null
  runnerId: string | null
  leaseEpoch: number
  state: FleetJobState
  stateReason: string | null
  requestedById: string
  queuedAt: string
  assignedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
  naxRunId: string | null
  naxLogRunId: string | null
  naxCostRunId: string | null
  progress: unknown
  currentStoryId: string | null
  currentPhase: string | null
  costSpentUsd: string
  lastHeartbeatAt: string | null
  finishResult: string | null
  escalationReason: string | null
  exitCode: number | null
  resultBranch: string | null
  resultSha: string | null
  resultPrUrl: string | null
  wipPush: string | null
}

export interface FleetJobEventDto {
  id: string
  seq: number
  leaseEpoch: number
  runnerSeq: number | null
  type: 'state' | 'snapshot' | 'lifecycle' | 'log'
  payload: unknown
  createdAt: string
}

export interface PlacementMisfit {
  runnerId: string
  name: string
  reason: MisfitReason
}

export interface DispatchResultDto {
  job: FleetJobDto
  placement: { assigned: boolean; runnerId: string | null; misfits: PlacementMisfit[] }
}

/** POST /projects/:slug/fleet/jobs body; bashMode is left to the server default (raw). */
export interface DispatchBody {
  repoId: string
  command: 'RUN' | 'PLAN'
  feature: string
  maxCostUsd: number
  ref?: string
  planFrom?: string
  profiles?: string[]
  selectorLabels?: string[]
  pinnedRunnerId?: string
}
