CREATE TABLE "FleetPrRuling" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "jobId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemKind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "appliedJobId" TEXT,
    "commentId" TEXT,
    "approvalRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FleetPrRuling_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FleetPrRuling_repoId_prNumber_state_idx" ON "FleetPrRuling"("repoId", "prNumber", "state");
CREATE INDEX "FleetPrRuling_jobId_itemId_idx" ON "FleetPrRuling"("jobId", "itemId");
CREATE INDEX "FleetPrRuling_projectId_idx" ON "FleetPrRuling"("projectId");
ALTER TABLE "FleetPrRuling" ADD CONSTRAINT "FleetPrRuling_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetPrRuling" ADD CONSTRAINT "FleetPrRuling_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
