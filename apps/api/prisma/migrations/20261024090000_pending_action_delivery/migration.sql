-- Fleet S5b 2aw US-001 (2aw-D1): the message an outcome note was handed to the agent on, so a requeued new-turn job
-- rebuilds the same delivery text (2aw-D4) instead of sending the note twice. An id only, like `approvalId`: no
-- relation to ChatMessage, because a delivery is a fact about the action, not an owner of the message.

-- AlterTable
ALTER TABLE "PendingAction" ADD COLUMN "deliveredMessageId" TEXT;

-- CreateIndex
CREATE INDEX "PendingAction_threadId_deliveredAt_idx" ON "PendingAction"("threadId", "deliveredAt");

-- CreateIndex
CREATE INDEX "PendingAction_deliveredMessageId_idx" ON "PendingAction"("deliveredMessageId");
