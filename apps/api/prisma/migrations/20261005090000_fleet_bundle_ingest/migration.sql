-- Fleet S2b (d) slice 1a: bundle ingest queue and analytics rows (spec §1).
CREATE TABLE "FleetBundleIngest" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "parserVersion" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "files" JSONB NOT NULL DEFAULT '{}',
    "liveCostUsd" DECIMAL(14,8),
    "ledgerCostUsd" DECIMAL(14,8),
    "error" TEXT,
    "ingestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetBundleIngest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetBundleIngest_artifactId_key" ON "FleetBundleIngest"("artifactId");
CREATE INDEX "FleetBundleIngest_status_nextAttemptAt_idx" ON "FleetBundleIngest"("status", "nextAttemptAt");
CREATE INDEX "FleetBundleIngest_jobId_idx" ON "FleetBundleIngest"("jobId");
ALTER TABLE "FleetBundleIngest" ADD CONSTRAINT "FleetBundleIngest_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "FleetJobArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetBundleIngest" ADD CONSTRAINT "FleetBundleIngest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetCostEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "runnerId" TEXT,
    "naxRunId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "agentName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelTier" TEXT,
    "profile" TEXT,
    "stage" TEXT NOT NULL,
    "sessionRole" TEXT,
    "featureName" TEXT NOT NULL,
    "storyId" TEXT,
    "callId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(14,8) NOT NULL,
    "pricingSource" TEXT,
    "confidence" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "FleetCostEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetCostEvent_jobId_leaseEpoch_callId_key" ON "FleetCostEvent"("jobId", "leaseEpoch", "callId");
CREATE INDEX "FleetCostEvent_projectId_at_idx" ON "FleetCostEvent"("projectId", "at");
CREATE INDEX "FleetCostEvent_repoId_at_idx" ON "FleetCostEvent"("repoId", "at");
CREATE INDEX "FleetCostEvent_runnerId_at_idx" ON "FleetCostEvent"("runnerId", "at");
CREATE INDEX "FleetCostEvent_model_at_idx" ON "FleetCostEvent"("model", "at");
ALTER TABLE "FleetCostEvent" ADD CONSTRAINT "FleetCostEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetStoryResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "featureName" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "complexity" TEXT,
    "initialComplexity" TEXT,
    "modelTier" TEXT,
    "finalTier" TEXT,
    "modelUsed" TEXT,
    "agentUsed" TEXT,
    "attempts" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "firstPassSuccess" BOOLEAN NOT NULL,
    "costUsd" DECIMAL(14,8) NOT NULL,
    "durationMs" INTEGER,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FleetStoryResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetStoryResult_jobId_leaseEpoch_storyId_key" ON "FleetStoryResult"("jobId", "leaseEpoch", "storyId");
CREATE INDEX "FleetStoryResult_projectId_completedAt_idx" ON "FleetStoryResult"("projectId", "completedAt");
ALTER TABLE "FleetStoryResult" ADD CONSTRAINT "FleetStoryResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetReviewResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT,
    "reviewer" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failOpen" BOOLEAN NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "findingsBySeverity" JSONB NOT NULL,
    "advisoryCount" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetReviewResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetReviewResult_jobId_leaseEpoch_recordId_key" ON "FleetReviewResult"("jobId", "leaseEpoch", "recordId");
CREATE INDEX "FleetReviewResult_projectId_at_idx" ON "FleetReviewResult"("projectId", "at");
ALTER TABLE "FleetReviewResult" ADD CONSTRAINT "FleetReviewResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
