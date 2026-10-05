import { Prisma, PrismaClient } from '@prisma/client';

let seq = 0;

export interface AnalyticsOwner {
  projectId: string;
  repoId: string;
  requestedById: string;
}

/** A finished fleet job straight into PG (slice 1b analytics tests). */
export async function insertAnalyticsJob(prisma: PrismaClient, o: AnalyticsOwner, over: Partial<{
  command: string; feature: string; state: string; leaseEpoch: number; finishedAt: Date | null; costSpentUsd: string;
  costCarriedUsd: string; finishResult: string | null; escalationReason: string | null; stateReason: string | null;
}> = {}): Promise<string> {
  const job = await prisma.fleetJob.create({
    data: {
      projectId: o.projectId, repoId: o.repoId, ref: 'main', command: over.command ?? 'RUN', feature: over.feature ?? `feat-${++seq}`,
      profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: o.requestedById,
      state: over.state ?? 'COMPLETED', leaseEpoch: over.leaseEpoch ?? 1,
      finishedAt: over.finishedAt === undefined ? new Date('2026-10-02T12:00:00Z') : over.finishedAt,
      costSpentUsd: new Prisma.Decimal(over.costSpentUsd ?? '0'), costCarriedUsd: new Prisma.Decimal(over.costCarriedUsd ?? '0'),
      finishResult: over.finishResult ?? null, escalationReason: over.escalationReason ?? null, stateReason: over.stateReason ?? null,
    },
  });
  return job.id;
}

export interface RowOwner {
  jobId: string;
  projectId: string;
  repoId: string;
  leaseEpoch?: number;
}

export async function insertCostEvent(prisma: PrismaClient, o: RowOwner, over: Partial<{
  at: Date; model: string; stage: string; sessionRole: string | null; storyId: string | null; costUsd: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}> = {}): Promise<void> {
  await prisma.fleetCostEvent.create({
    data: {
      jobId: o.jobId, leaseEpoch: o.leaseEpoch ?? 1, projectId: o.projectId, repoId: o.repoId, runnerId: null, naxRunId: 'run-1',
      at: over.at ?? new Date('2026-10-02T10:00:00Z'), agentName: 'native', model: over.model ?? 'm1', stage: over.stage ?? 'run',
      sessionRole: over.sessionRole === undefined ? 'implementer' : over.sessionRole, featureName: 'f',
      storyId: over.storyId === undefined ? 'US-001' : over.storyId, callId: `call-${++seq}`,
      inputTokens: over.inputTokens ?? 100, outputTokens: over.outputTokens ?? 10,
      cacheReadTokens: over.cacheReadTokens ?? 0, cacheWriteTokens: over.cacheWriteTokens ?? 0,
      costUsd: new Prisma.Decimal(over.costUsd ?? '0.01'),
    },
  });
}

export async function insertStoryResult(prisma: PrismaClient, o: RowOwner, over: Partial<{
  storyId: string; attempts: number; success: boolean; firstPassSuccess: boolean; costUsd: string; completedAt: Date | null;
}> = {}): Promise<void> {
  await prisma.fleetStoryResult.create({
    data: {
      jobId: o.jobId, leaseEpoch: o.leaseEpoch ?? 1, projectId: o.projectId, repoId: o.repoId, featureName: 'f',
      storyId: over.storyId ?? `US-${++seq}`, attempts: over.attempts ?? 1, success: over.success ?? true,
      firstPassSuccess: over.firstPassSuccess ?? true, costUsd: new Prisma.Decimal(over.costUsd ?? '0.1'), durationMs: 1000,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      completedAt: over.completedAt === undefined ? new Date('2026-10-02T11:00:00Z') : over.completedAt,
    },
  });
}

export async function insertReviewResult(prisma: PrismaClient, o: RowOwner, over: Partial<{
  reviewer: string; passed: boolean; findingsBySeverity: Record<string, number>; at: Date;
}> = {}): Promise<void> {
  const findings = over.findingsBySeverity ?? {};
  await prisma.fleetReviewResult.create({
    data: {
      jobId: o.jobId, leaseEpoch: o.leaseEpoch ?? 1, projectId: o.projectId, storyId: 'US-001', reviewer: over.reviewer ?? 'semantic',
      recordId: `rec-${++seq}`, passed: over.passed ?? true, failOpen: false,
      findingCount: Object.values(findings).reduce((a, b) => a + b, 0), findingsBySeverity: findings, advisoryCount: 0,
      at: over.at ?? new Date('2026-10-02T11:30:00Z'),
    },
  });
}

/** A bundle artifact and its ingest row for one attempt. */
export async function insertIngestRow(prisma: PrismaClient, jobId: string, leaseEpoch: number, over: Partial<{
  status: string; liveCostUsd: string | null; ledgerCostUsd: string | null; files: Record<string, string>; error: string | null;
}> = {}): Promise<void> {
  const artifact = await prisma.fleetJobArtifact.create({
    data: { jobId, leaseEpoch, kind: 'bundle', storageKey: `jobs/${jobId}/${leaseEpoch}/b${++seq}.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64) },
  });
  const money = (v: string | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v));
  await prisma.fleetBundleIngest.create({
    data: {
      artifactId: artifact.id, jobId, leaseEpoch, parserVersion: 1, status: over.status ?? 'done', files: over.files ?? { cost: 'done:v8' },
      ingestedAt: new Date('2026-10-02T13:00:00Z'), liveCostUsd: money(over.liveCostUsd), ledgerCostUsd: money(over.ledgerCostUsd),
      error: over.error ?? null,
    },
  });
}
