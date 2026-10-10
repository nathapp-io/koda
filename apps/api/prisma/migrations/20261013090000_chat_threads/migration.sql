-- Fleet S5a US-002: chat threads, messages, THREAD job turns, runner thread capacity (spec §1).
-- AlterTable
ALTER TABLE "Runner" ADD COLUMN     "threadCapacity" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "FleetJob" ADD COLUMN     "threadId" TEXT;

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "baseRef" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "runnerId" TEXT,
    "backend" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "skills" JSONB NOT NULL,
    "maxCostUsd" DECIMAL(12,4) NOT NULL DEFAULT 5,
    "costUsd" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "tokens" JSONB,
    "specPath" TEXT NOT NULL,
    "pendingQuestion" JSONB,
    "nextSeq" INTEGER NOT NULL DEFAULT 1,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "jobId" TEXT,
    "turnId" TEXT,
    "role" TEXT NOT NULL,
    "authorUserId" TEXT,
    "clientMessageId" TEXT,
    "content" TEXT NOT NULL,
    "toolSummary" JSONB,
    "status" TEXT NOT NULL,
    "errorReason" TEXT,
    "usage" JSONB,
    "costUsd" DECIMAL(12,4),
    "costSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetThreadTurn" (
    "jobId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "initialMessageId" TEXT,
    "instructions" TEXT NOT NULL,
    "backend" JSONB NOT NULL,
    "skills" JSONB NOT NULL,
    "resume" BOOLEAN NOT NULL,

    CONSTRAINT "FleetThreadTurn_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "ChatThread_projectId_lastActivityAt_idx" ON "ChatThread"("projectId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "ChatThread_runnerId_status_idx" ON "ChatThread"("runnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_seq_key" ON "ChatMessage"("threadId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_clientMessageId_key" ON "ChatMessage"("threadId", "clientMessageId");

-- CreateIndex
CREATE INDEX "FleetJob_threadId_idx" ON "FleetJob"("threadId");

-- Partial unique: one ACTIVE thread per repo and feature. Shipped verbatim by test/helpers/partial-indexes.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "ChatThread_active_repo_feature_key" ON "ChatThread" ("repoId", "feature") WHERE "status" = 'ACTIVE';

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "Runner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetThreadTurn" ADD CONSTRAINT "FleetThreadTurn_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetThreadTurn" ADD CONSTRAINT "FleetThreadTurn_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
