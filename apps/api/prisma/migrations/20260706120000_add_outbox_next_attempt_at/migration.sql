-- Add nextAttemptAt to OutboxEvent for exponential-backoff retry scheduling
ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" DATETIME;

CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
