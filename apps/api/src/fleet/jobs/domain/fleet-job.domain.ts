import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetCommandType, FleetJobKind, FleetJobState } from '../../../common/enums';
import type { RunnerCapabilities } from '../../common/protocol';
import type { PlacementRunner } from '../placement-rules';

export const FLEET_JOB_REPOSITORY = Symbol('FLEET_JOB_REPOSITORY');

/** createJob hit the partial unique index on active (repoId, feature) (spec §6.4). */
export class DuplicateActiveJobError extends Error {
  constructor() {
    super('an active job already exists for this repo and feature');
  }
}

/** S1b §1.2: one PRD user story as the runner reported it. */
export interface FleetJobStory {
  id: string;
  title: string;
  status: string;
  attempts: number;
  dependsOn: string[];
}

export interface FleetJobRecord {
  id: string;
  projectId: string;
  repoId: string;
  ref: string;
  command: FleetJobKind;
  feature: string;
  planFrom: string | null;
  profiles: string[];
  /** Decimal as string. */
  maxCostUsd: string;
  bashMode: string;
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  runnerId: string | null;
  runnerBootId: string | null;
  leaseEpoch: number;
  state: FleetJobState;
  stateReason: string | null;
  requestedById: string;
  queuedAt: Date;
  assignedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  naxRunId: string | null;
  naxLogRunId: string | null;
  naxCostRunId: string | null;
  progress: unknown;
  currentStoryId: string | null;
  currentPhase: string | null;
  /** Decimal as string. */
  costSpentUsd: string;
  lastHeartbeatAt: Date | null;
  finishResult: string | null;
  escalationReason: string | null;
  exitCode: number | null;
  resultBranch: string | null;
  resultSha: string | null;
  resultPrUrl: string | null;
  wipPush: string | null;
  stories: FleetJobStory[] | null;
  storiesTruncated: boolean;
  eventSeq: number;
  ackedRunnerSeq: number;
  attributedAt: Date | null;
  updatedAt: Date;
}

export interface NewFleetJob {
  projectId: string;
  repoId: string;
  ref: string;
  command: FleetJobKind;
  feature: string;
  planFrom: string | null;
  profiles: string[];
  maxCostUsd: string;
  bashMode: 'raw';
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  requestedById: string;
}

type Mutable =
  | 'state' | 'stateReason' | 'runnerId' | 'runnerBootId' | 'assignedAt' | 'startedAt' | 'finishedAt'
  | 'cancelRequestedAt' | 'naxRunId' | 'naxLogRunId' | 'naxCostRunId' | 'progress' | 'currentStoryId'
  | 'currentPhase' | 'costSpentUsd' | 'lastHeartbeatAt' | 'finishResult' | 'escalationReason' | 'exitCode'
  | 'resultBranch' | 'resultSha' | 'resultPrUrl' | 'wipPush' | 'stories' | 'storiesTruncated' | 'ackedRunnerSeq';

/** Columns a transition, snapshot or requeue may change. `bumpEpoch` adds one to leaseEpoch (plan D4). */
export type FleetJobPatch = Partial<Pick<FleetJobRecord, Mutable>> & { bumpEpoch?: boolean };

export interface FleetJobFilters {
  projectId: string;
  state?: string;
  repoId?: string;
  runnerId?: string;
  requestedById?: string;
  feature?: string;
}

export interface FleetJobEventRecord {
  id: string;
  jobId: string;
  seq: number;
  leaseEpoch: number;
  runnerSeq: number | null;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface FleetCommandRecord {
  id: string;
  runnerId: string;
  jobId: string;
  type: FleetCommandType;
  leaseEpoch: number;
  payload: unknown;
  createdAt: Date;
  deliveredAt: Date | null;
  ackedAt: Date | null;
  ackResult: string | null;
}

export interface FleetArtifactRecord {
  id: string;
  jobId: string;
  leaseEpoch: number;
  kind: string;
  storageKey: string;
  sizeBytes: bigint;
  sha256: string;
  createdAt: Date;
}

export interface FleetRepoRef {
  id: string;
  projectId: string;
  provider: 'github' | 'gitlab';
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: bigint | null;
}

export interface ActiveJobRef {
  runnerId: string;
  repoId: string;
}

export type PlacementRunnerRow = PlacementRunner & { bootId: string };

export interface IFleetJobRepository {
  findRepo(repoId: string): Promise<FleetRepoRef | null>;
  /** @throws DuplicateActiveJobError */
  createJob(data: NewFleetJob): Promise<FleetJobRecord>;
  findActiveJobId(repoId: string, feature: string): Promise<string | null>;
  findById(id: string): Promise<FleetJobRecord | null>;
  /** SELECT … FOR UPDATE (inside txManager.run). With skipLocked, null when another transaction holds the row. */
  lockById(id: string, opts?: { skipLocked?: boolean }): Promise<FleetJobRecord | null>;
  findPage(filters: FleetJobFilters, page: IPageOption): Promise<IPageResult<FleetJobRecord>>;
  /** Spec §6.1. New leaseEpoch, or null when the job was no longer QUEUED. Resets ackedRunnerSeq. */
  casAssign(jobId: string, runnerId: string, runnerBootId: string, now: Date): Promise<number | null>;
  update(id: string, patch: FleetJobPatch): Promise<FleetJobRecord>;
  /** Oldest first. */
  findQueuedIds(limit: number): Promise<string[]>;
  findRunnerHeld(runnerId: string): Promise<FleetJobRecord[]>;
  /** Jobs held by a runner whose lastSeenAt is before the cutoff. */
  findSilentHeldIds(runnerSeenBefore: Date): Promise<string[]>;
  /** Updates lastSeenAt and the reported fields; returns the boot id stored before this sync, or null if the runner is gone. */
  recordRunnerSync(runnerId: string, s: { now: Date; bootId: string; daemonVersion: string; protocolVersion: number; capabilities?: RunnerCapabilities }): Promise<{ previousBootId: string } | null>;

  findPlacementRunners(ids?: readonly string[]): Promise<PlacementRunnerRow[]>;
  /** Locks runner rows in id order (all when ids is undefined); returns the locked ids. */
  lockRunners(ids?: readonly string[]): Promise<string[]>;
  findActiveLoads(runnerIds: readonly string[]): Promise<ActiveJobRef[]>;

  /** Takes the next server seq from FleetJob.eventSeq (row-locked by the increment). */
  appendEvent(jobId: string, event: { leaseEpoch: number; runnerSeq: number | null; type: string; payload: unknown }): Promise<FleetJobEventRecord>;
  findRunnerEvents(jobId: string, leaseEpoch: number, runnerSeqs: readonly number[]): Promise<FleetJobEventRecord[]>;
  /** Runner events of the epoch with runnerSeq > after, ascending by runnerSeq. */
  findRunnerEventsAfter(jobId: string, leaseEpoch: number, afterRunnerSeq: number): Promise<FleetJobEventRecord[]>;
  findEventPage(jobId: string, page: IPageOption): Promise<IPageResult<FleetJobEventRecord>>;

  createCommand(command: { runnerId: string; jobId: string; type: FleetCommandType; leaseEpoch: number; payload: object }): Promise<FleetCommandRecord>;
  /** Unacked commands for the runner, oldest first. */
  findPendingCommands(runnerId: string): Promise<FleetCommandRecord[]>;
  markDelivered(ids: readonly string[], now: Date): Promise<void>;
  findCommand(id: string): Promise<FleetCommandRecord | null>;
  ackCommand(id: string, result: string, now: Date): Promise<void>;
  findPendingCommand(filter: { jobId: string; type: FleetCommandType; runnerId?: string; leaseEpoch?: number }): Promise<FleetCommandRecord | null>;
  /** Plan D4: marks the job's pending non-ABANDON commands withdrawn; returns how many. */
  withdrawPendingCommands(jobId: string, now: Date): Promise<number>;

  upsertArtifact(artifact: Omit<FleetArtifactRecord, 'id' | 'createdAt'>): Promise<FleetArtifactRecord>;
  findArtifact(jobId: string, kind: string, leaseEpoch: number): Promise<FleetArtifactRecord | null>;
  findLatestArtifact(jobId: string, kind: string): Promise<FleetArtifactRecord | null>;

  /** Plan D19: sets attributedAt when still null; true when this call claimed it. */
  claimAttribution(jobId: string, now: Date): Promise<boolean>;
  findUserDisplayName(userId: string): Promise<string | null>;
}
