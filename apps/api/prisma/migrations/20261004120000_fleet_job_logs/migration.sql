-- Fleet S2a slice 1a: complete run logs (spec §1.2) and retention markers (spec §5).
CREATE TABLE "FleetJobLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'stream',
    "expiredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetJobLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FleetJobLog_jobId_leaseEpoch_stream_key" ON "FleetJobLog"("jobId", "leaseEpoch", "stream");
CREATE INDEX "FleetJobLog_jobId_idx" ON "FleetJobLog"("jobId");
ALTER TABLE "FleetJobLog" ADD CONSTRAINT "FleetJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FleetJobArtifact" ADD COLUMN "expiredAt" TIMESTAMP(3);

CREATE INDEX "FleetJob_state_finishedAt_idx" ON "FleetJob"("state", "finishedAt");
