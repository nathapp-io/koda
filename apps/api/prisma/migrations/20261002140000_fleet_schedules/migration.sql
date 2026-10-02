-- S1b slice 3a: job schedules, and the schedule link on FleetJob.
-- AlterTable
ALTER TABLE "FleetJob" ADD COLUMN     "coalescedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleCountedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleId" TEXT;

-- CreateTable
CREATE TABLE "JobSchedule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "profiles" TEXT[],
    "maxCostUsd" DECIMAL(12,4) NOT NULL,
    "selectorLabels" TEXT[],
    "pinnedRunnerId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextFireAt" TIMESTAMP(3) NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "lastJobId" TEXT,
    "lastPassedCount" INTEGER NOT NULL DEFAULT 0,
    "noProgressTicks" INTEGER NOT NULL DEFAULT 0,
    "noProgressLimit" INTEGER NOT NULL DEFAULT 3,
    "disabledReason" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobSchedule_enabled_nextFireAt_idx" ON "JobSchedule"("enabled", "nextFireAt");

-- CreateIndex
CREATE INDEX "JobSchedule_projectId_idx" ON "JobSchedule"("projectId");

-- CreateIndex
CREATE INDEX "FleetJob_scheduleId_queuedAt_idx" ON "FleetJob"("scheduleId", "queuedAt");

-- AddForeignKey
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "JobSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSchedule" ADD CONSTRAINT "JobSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- S1b §3.1: at most one QUEUED job per schedule (the coalescing invariant); prisma db push cannot express this.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_schedule_queued_key" ON "FleetJob" ("scheduleId") WHERE "state" = 'QUEUED';
