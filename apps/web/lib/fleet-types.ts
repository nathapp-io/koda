/**
 * Fleet S1 wire types for the web (hand-written: the web has no generated client).
 * Shapes follow docs/superpowers/plans/2026-10-01-fleet-s1-slice-4-overview.md.
 */

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
