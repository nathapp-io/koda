-- Fleet S5a US-001: the thread log stream's fold cursor, the thread session and the message stream rounds.

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "session" JSONB;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "streamRound" INTEGER,
ADD COLUMN     "streamRoundStart" INTEGER;

-- CreateTable
CREATE TABLE "ThreadIngestCursor" (
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "offset" BIGINT NOT NULL DEFAULT 0,
    "skippedLines" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadIngestCursor_pkey" PRIMARY KEY ("jobId","leaseEpoch")
);

-- AddForeignKey
ALTER TABLE "ThreadIngestCursor" ADD CONSTRAINT "ThreadIngestCursor_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
