-- Issue #135: nightly retention purge deletes terminal (published/dead) rows
-- by an updatedAt cutoff; this index keeps that deleteMany index-served.
CREATE INDEX "OutboxEvent_status_updatedAt_idx" ON "OutboxEvent"("status", "updatedAt");
