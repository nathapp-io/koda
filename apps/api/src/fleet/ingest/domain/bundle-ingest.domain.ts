import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const BUNDLE_INGEST_REPOSITORY = Symbol('BUNDLE_INGEST_REPOSITORY');

/** Bump when a parser changes what it writes; `rerun-outdated` re-ingests older rows (spec §2.6). */
export const INGEST_PARSER_VERSION = 1;
export const INGEST_MAX_ATTEMPTS = 5;
/** Delay after failure n (1-based), spec §2.5. */
export const INGEST_BACKOFF_MS: readonly number[] = [60_000, 300_000, 1_800_000, 7_200_000];
export const INGEST_STALE_CLAIM_MS = 600_000;
/** Rows one drain pass ingests at most (D369). */
export const INGEST_DRAIN_LIMIT = 50;

export const INGEST_LIMITS = {
  fileBytes: 33_554_432,
  costEvents: 50_000,
  stories: 2_000,
  reviews: 5_000,
  shortText: 120,
  idText: 200,
  reasonText: 2_000,
  errorText: 500,
} as const;

export type IngestStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed';
export const INGEST_STATUSES: readonly IngestStatus[] = ['pending', 'running', 'done', 'partial', 'failed'];

export interface IngestClaim {
  id: string;
  artifactId: string;
  jobId: string;
  leaseEpoch: number;
  attempts: number;
}

export interface IngestArtifact {
  storageKey: string;
  expiredAt: Date | null;
}

export interface CostEventRow {
  at: Date;
  agentName: string;
  model: string;
  modelTier: string | null;
  profile: string | null;
  stage: string;
  sessionRole: string | null;
  featureName: string;
  storyId: string | null;
  callId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Decimal string, up to 8 places. */
  costUsd: string;
  pricingSource: string | null;
  confidence: string | null;
  durationMs: number | null;
}

export interface StoryResultRow {
  featureName: string;
  storyId: string;
  complexity: string | null;
  initialComplexity: string | null;
  modelTier: string | null;
  finalTier: string | null;
  modelUsed: string | null;
  agentUsed: string | null;
  attempts: number;
  success: boolean;
  firstPassSuccess: boolean;
  costUsd: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ReviewResultRow {
  storyId: string | null;
  reviewer: string;
  recordId: string;
  passed: boolean;
  failOpen: boolean;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  advisoryCount: number;
  at: Date;
}

/** Copied onto every analytics row (D372). */
export interface IngestContext {
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  repoId: string;
  runnerId: string | null;
  naxRunId: string | null;
}

export interface IngestRows {
  costEvents: readonly CostEventRow[];
  stories: readonly StoryResultRow[];
  reviews: readonly ReviewResultRow[];
}

export interface IngestOutcome {
  kind: 'done' | 'partial';
  files: Record<string, string>;
  liveCostUsd: string | null;
  ledgerCostUsd: string;
  ingestedAt: Date;
}

export interface IngestListRow {
  id: string;
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  status: IngestStatus;
  attempts: number;
  parserVersion: number;
  files: Record<string, string>;
  error: string | null;
  ingestedAt: Date | null;
  updatedAt: Date;
}

export interface IBundleIngestRepository {
  /** Insert or reset to pending the ingest row of an artifact (spec §2.1). Call inside the upload transaction. */
  enqueue(artifactId: string, jobId: string, leaseEpoch: number, parserVersion: number): Promise<void>;
  /** One eligible row (job terminal; pending and due, or a stale running claim), claimed as running (spec §2.2). */
  claimNext(now: Date): Promise<IngestClaim | null>;
  findArtifact(artifactId: string): Promise<IngestArtifact | null>;
  /** Delete then insert this attempt's analytics rows (spec §2.4). Call inside the write transaction. */
  replaceRows(ctx: IngestContext, rows: IngestRows): Promise<void>;
  markOutcome(id: string, outcome: IngestOutcome): Promise<void>;
  markRetry(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  markFailed(id: string, attempts: number, error: string): Promise<void>;
  /** Pending rows for every unexpired bundle artifact without one; returns how many (spec §2.6). */
  backfill(parserVersion: number): Promise<number>;
  /** Reset every ingest row of a job to pending with attempts 0; returns how many. */
  rerunJob(jobId: string): Promise<number>;
  /** Reset done/partial/failed rows below `parserVersion` whose artifact is unexpired; returns how many. */
  rerunOutdated(parserVersion: number): Promise<number>;
  findPage(filters: { status?: IngestStatus }, page: IPageOption): Promise<IPageResult<IngestListRow>>;
}
