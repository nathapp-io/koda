CREATE TABLE "AssistantActionRequest" (
  "requestId" TEXT NOT NULL,
  "threadId" TEXT,
  "jobId" TEXT,
  "toolCallId" TEXT,
  "tool" TEXT NOT NULL,
  "preview" TEXT NOT NULL,
  "noteMessageId" TEXT,
  "notedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "deliveredMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantActionRequest_pkey" PRIMARY KEY ("requestId")
);
CREATE INDEX "AssistantActionRequest_threadId_idx" ON "AssistantActionRequest"("threadId");
CREATE INDEX "AssistantActionRequest_threadId_deliveredAt_idx" ON "AssistantActionRequest"("threadId", "deliveredAt");
CREATE INDEX "AssistantActionRequest_deliveredMessageId_idx" ON "AssistantActionRequest"("deliveredMessageId");
ALTER TABLE "AssistantActionRequest" ADD CONSTRAINT "AssistantActionRequest_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantActionRequest" ADD CONSTRAINT "AssistantActionRequest_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
