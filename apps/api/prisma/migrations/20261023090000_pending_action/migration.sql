-- Fleet S5b 2a US-001 (2a-D3): one proposed koda action per write-tool call, decided by the thread's creator.
-- Owned by its thread; `input` is the parsed input without the WORKSPACE `project` key, and `projectId` is the
-- project the action acts in (the resolved project for a WORKSPACE call, not the thread's home project).

-- CreateTable
CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "preview" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvalId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "result" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingAction_approvalId_key" ON "PendingAction"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingAction_jobId_toolCallId_key" ON "PendingAction"("jobId", "toolCallId");

-- CreateIndex
CREATE INDEX "PendingAction_threadId_status_idx" ON "PendingAction"("threadId", "status");

-- CreateIndex
CREATE INDEX "PendingAction_status_expiresAt_idx" ON "PendingAction"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
