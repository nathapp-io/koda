-- review-1119 US-003: the nightly settled-request purge.
--
-- `PrismaApprovalRequestRepository.deleteSettledBefore` deletes in one statement, filtering on the
-- request's `status` (the settled states) and its `updatedAt` (the cutoff). Without this index that
-- statement scans the whole table every night; `(status, updatedAt)` answers both halves of the
-- predicate. No column changes and no data moves: a purge deletes rows, it does not rewrite them.

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_updatedAt_idx" ON "ApprovalRequest"("status", "updatedAt");
