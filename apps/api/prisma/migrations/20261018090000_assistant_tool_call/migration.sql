-- Fleet S5b US-002: the hash-only audit and replay ledger of koda tool calls. Rows go with their job.
-- CreateTable
CREATE TABLE "AssistantToolCall" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isError" BOOLEAN NOT NULL,
    "resultBytes" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantToolCall_threadId_createdAt_idx" ON "AssistantToolCall"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantToolCall_jobId_toolCallId_key" ON "AssistantToolCall"("jobId", "toolCallId");

-- AddForeignKey
ALTER TABLE "AssistantToolCall" ADD CONSTRAINT "AssistantToolCall_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
