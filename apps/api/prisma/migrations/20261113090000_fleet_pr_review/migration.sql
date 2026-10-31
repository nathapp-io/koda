-- Fleet auto-review US-005: one row per (repo, PR number, head SHA). The unique index is the claim that
-- stops two passes from dispatching the same head twice; `outcome` records what became of it.
CREATE TABLE "FleetPrReview" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "jobId" TEXT,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FleetPrReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FleetPrReview_repoId_prNumber_headSha_key" ON "FleetPrReview"("repoId", "prNumber", "headSha");

ALTER TABLE "FleetPrReview" ADD CONSTRAINT "FleetPrReview_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
