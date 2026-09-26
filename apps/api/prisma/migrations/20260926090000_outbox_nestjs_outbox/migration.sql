-- Track 1 slice 2: reshape OutboxEvent for @nathapp/nestjs-outbox

-- Renames keep existing values
ALTER TABLE "OutboxEvent" RENAME COLUMN "eventType" TO "type";
ALTER TABLE "OutboxEvent" RENAME COLUMN "processedAt" TO "publishedAt";

-- Lease and header columns
ALTER TABLE "OutboxEvent" ADD COLUMN "headers" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3), ADD COLUMN "owner" TEXT;

-- Status vocabulary: completed -> published, dead_letter -> dead
UPDATE "OutboxEvent" SET "status" = 'published' WHERE "status" = 'completed';
UPDATE "OutboxEvent" SET "status" = 'dead' WHERE "status" = 'dead_letter';

-- failed rows and lease-less processing rows from the old processor are retried now
UPDATE "OutboxEvent" SET "status" = 'pending', "nextAttemptAt" = CURRENT_TIMESTAMP WHERE "status" IN ('failed', 'processing');

-- nextAttemptAt becomes required
UPDATE "OutboxEvent" SET "nextAttemptAt" = "createdAt" WHERE "nextAttemptAt" IS NULL;
ALTER TABLE "OutboxEvent" ALTER COLUMN "nextAttemptAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "nextAttemptAt" SET NOT NULL;

-- Claim query serves its expired-lease reclaim branch from this index
CREATE INDEX "OutboxEvent_status_leaseUntil_idx" ON "OutboxEvent"("status", "leaseUntil");
