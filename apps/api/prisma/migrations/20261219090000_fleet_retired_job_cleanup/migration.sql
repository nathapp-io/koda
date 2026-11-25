-- US-009 (finding 5): the file cleanup work a fleet repository deletion hands to the retention pass.
--
-- Deleting a FleetRepo cascades away its FleetJob rows and, with them, the FleetJobLog and
-- FleetJobArtifact rows that are the only lookup for the job's stored log prefixes and bundle keys.
-- The delete therefore copies those targets into this independent table inside its own transaction,
-- before the cascade, and the nightly retention pass deletes the files and then the record.
--
-- No foreign key to FleetJob/FleetRepo on purpose: the parents are gone by design, and a record is
-- removed only once every one of its targets is deleted. Existing job history is untouched — this is
-- an additive table, and every row that predates it keeps its own cascade behaviour.
CREATE TABLE "FleetRetiredJobCleanup" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    -- Required, as the model's `bundleKeys String[]` is: a deleted job that uploaded no bundle stores '{}'.
    "bundleKeys" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetRetiredJobCleanup_pkey" PRIMARY KEY ("id")
);

-- One record per deleted job: a captured delete that is retried cannot double the work.
CREATE UNIQUE INDEX "FleetRetiredJobCleanup_jobId_key" ON "FleetRetiredJobCleanup"("jobId");

-- The retention pass reads its due work by (finishedAt, id) under the cutoff, in bounded pages.
CREATE INDEX "FleetRetiredJobCleanup_finishedAt_id_idx" ON "FleetRetiredJobCleanup"("finishedAt", "id");
