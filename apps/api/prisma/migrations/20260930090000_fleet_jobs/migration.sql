-- Fleet S1 slice 2: jobs, events, commands, artifacts; FleetActivity.projectId (plan D14).
-- AlterTable
ALTER TABLE "FleetActivity" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "FleetJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "planFrom" TEXT,
    "profiles" TEXT[],
    "maxCostUsd" DECIMAL(12,4) NOT NULL,
    "bashMode" TEXT NOT NULL DEFAULT 'raw',
    "selectorLabels" TEXT[],
    "pinnedRunnerId" TEXT,
    "runnerId" TEXT,
    "runnerBootId" TEXT,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "stateReason" TEXT,
    "requestedById" TEXT NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "naxRunId" TEXT,
    "naxLogRunId" TEXT,
    "naxCostRunId" TEXT,
    "progress" JSONB,
    "currentStoryId" TEXT,
    "currentPhase" TEXT,
    "costSpentUsd" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3),
    "finishResult" TEXT,
    "escalationReason" TEXT,
    "exitCode" INTEGER,
    "resultBranch" TEXT,
    "resultSha" TEXT,
    "resultPrUrl" TEXT,
    "eventSeq" INTEGER NOT NULL DEFAULT 0,
    "ackedRunnerSeq" INTEGER NOT NULL DEFAULT 0,
    "attributedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "runnerSeq" INTEGER,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetCommand" (
    "id" TEXT NOT NULL,
    "runnerId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "ackResult" TEXT,

    CONSTRAINT "FleetCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetJobArtifact" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetJobArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FleetJob_state_idx" ON "FleetJob"("state");

-- CreateIndex
CREATE INDEX "FleetJob_runnerId_state_idx" ON "FleetJob"("runnerId", "state");

-- CreateIndex
CREATE INDEX "FleetJob_projectId_queuedAt_idx" ON "FleetJob"("projectId", "queuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetJobEvent_jobId_seq_key" ON "FleetJobEvent"("jobId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "FleetJobEvent_jobId_leaseEpoch_runnerSeq_key" ON "FleetJobEvent"("jobId", "leaseEpoch", "runnerSeq");

-- CreateIndex
CREATE INDEX "FleetCommand_runnerId_ackedAt_idx" ON "FleetCommand"("runnerId", "ackedAt");

-- CreateIndex
CREATE INDEX "FleetCommand_jobId_idx" ON "FleetCommand"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetJobArtifact_jobId_kind_leaseEpoch_key" ON "FleetJobArtifact"("jobId", "kind", "leaseEpoch");

-- CreateIndex
CREATE INDEX "FleetActivity_projectId_idx" ON "FleetActivity"("projectId");

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "Runner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_pinnedRunnerId_fkey" FOREIGN KEY ("pinnedRunnerId") REFERENCES "Runner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJobEvent" ADD CONSTRAINT "FleetJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetCommand" ADD CONSTRAINT "FleetCommand_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "Runner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetCommand" ADD CONSTRAINT "FleetCommand_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJobArtifact" ADD CONSTRAINT "FleetJobArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Active-job guard (spec §2, §6.4). Also replayed by test/global-setup.ts after `prisma db push`.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_active_repo_feature_key" ON "FleetJob" ("repoId", "feature") WHERE "state" IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING');
