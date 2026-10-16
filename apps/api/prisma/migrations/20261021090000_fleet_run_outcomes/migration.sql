-- Fleet S5b-1c-c-2 (3c-2-D1): the bounded RUN feature report and decisions log of one ingest attempt.
-- Rows are epoch-scoped and replaced by each re-ingest of the same attempt; they go with their job.

-- CreateTable
CREATE TABLE "FleetRunOutcome" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetRunOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FleetRunOutcome_projectId_idx" ON "FleetRunOutcome"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetRunOutcome_jobId_leaseEpoch_kind_key" ON "FleetRunOutcome"("jobId", "leaseEpoch", "kind");

-- AddForeignKey
ALTER TABLE "FleetRunOutcome" ADD CONSTRAINT "FleetRunOutcome_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
