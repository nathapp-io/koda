-- CreatePhase1OutboxEvent
-- Creates the canonical OutboxEvent table with all Phase 1 fields and indexes.
-- Uses CREATE TABLE IF NOT EXISTS for idempotent application.
-- FK constraint is managed via schema.prisma relations, not raw SQL in migrations.

BEGIN TRANSACTION;

-- CreateTable: OutboxEvent with Phase 1 contract fields
-- Note: Foreign key constraint is defined in schema.prisma, not here, to ensure
-- migration idempotency (SQLite inline FK constraints cannot use IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex: @@index([status, createdAt])
CREATE INDEX IF NOT EXISTS "OutboxEvent_status_createdAt_idx"
    ON "OutboxEvent"("status", "createdAt");

-- CreateIndex: @@index([projectId, createdAt])
CREATE INDEX IF NOT EXISTS "OutboxEvent_projectId_createdAt_idx"
    ON "OutboxEvent"("projectId", "createdAt");

COMMIT;