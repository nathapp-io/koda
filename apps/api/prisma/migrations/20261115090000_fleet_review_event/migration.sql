CREATE TABLE "FleetReviewEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "findingKey" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "file" TEXT,
    "line" INTEGER,
    "finding" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "disagreedBy" TEXT[],
    "trusted" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "approverLogin" TEXT,
    "memoryItemId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FleetReviewEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FleetReviewEvent_jobId_leaseEpoch_threadId_key" ON "FleetReviewEvent"("jobId", "leaseEpoch", "threadId");
CREATE INDEX "FleetReviewEvent_status_createdAt_idx" ON "FleetReviewEvent"("status", "createdAt");
ALTER TABLE "FleetReviewEvent" ADD CONSTRAINT "FleetReviewEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
