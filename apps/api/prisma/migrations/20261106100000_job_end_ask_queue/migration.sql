-- Pending links rotate to the tail when the job-end sweeper schedules an attempt.
CREATE INDEX "FleetApprovalAsk_updatedAt_requestId_idx" ON "FleetApprovalAsk"("updatedAt", "requestId");
